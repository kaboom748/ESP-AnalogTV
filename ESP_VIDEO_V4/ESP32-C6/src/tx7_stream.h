/* TX7 v1 wire protocol from kaboom748/ESP-AnalogTV ESP_VIDEO_V3.
 * Incremental implementation for the ESP32-C5 hard realtime transmitter.
 * The alphabet, frame format, sequence and CRC are unchanged. Unlike the
 * upstream decoder, no end-of-packet loop copies/decodes a whole block.
 */
#pragma once
#include <stddef.h>
#include <stdint.h>

struct Tx7Stats {
    uint32_t wire_bytes=0, blocks=0, samples=0, resync=0;
    uint32_t crc=0, sequence=0, protocol=0, overflow=0, truncated=0, timeout=0, dropped_samples=0;
};

class Tx7Stream {
public:
    void reset() { *this=Tx7Stream(); }
    const char *error=nullptr;
    uint8_t error_code=0;
    bool finished=false;
    Tx7Stats stats;
    uint32_t expected_index=0;
    bool boundary() const { return used_==0 && matched_==0 && discarded_==0; }
    void fail(const char *reason,uint8_t code=2) { if(!error) {error=reason;error_code=code;} }
    void end_of_input() {
        if(!finished && !error) {
            if(boundary()) {++stats.protocol;fail("TX7_NO_FIN",12);}
            else {++stats.truncated;fail("TX7_TRUNCATED",9);}
        }
    }

    template<class Sink> __attribute__((always_inline)) inline void feed(uint8_t byte, Sink &sink, const uint32_t *table) {
        if(error) return;
        if(finished) { ++stats.protocol; fail("TX7_AFTER_FIN",13); return; }
        ++stats.wire_bytes;
        if(!used_) {
            const uint8_t expected=matched_==0?0x54:matched_==1?0x58:matched_==2?0x37:0xa7;
            if(byte==expected) {
                header_[matched_]=byte;
                crc_=update(crc_,byte,table);
                if(++matched_==4) { used_=4; matched_=0; }
            } else {
                const uint8_t keep=byte==0x54?1:0;
                const uint16_t lost=matched_+1-keep;
                discarded_+=lost; stats.resync+=lost; matched_=keep;
                crc_=0xffffffffu;
                if(keep) { header_[0]=byte; crc_=update(crc_,byte,table); }
                if(discarded_>512) { ++stats.protocol; fail("TX7_SYNC",1); }
            }
            return;
        }
        const uint16_t at=used_++;
        if(at<12) {
            header_[at]=byte; crc_=update(crc_,byte,table);
            if(used_==12) {
                count_=uint16_t(header_[6])|(uint16_t(header_[7])<<8);
                const bool fin=header_[5]==1;
                if(header_[4]!=1 || header_[5]>1) {++stats.protocol;fail("TX7_PACKET",2);return;}
                if(fin?count_!=0:(count_==0 || count_>256)) {++stats.protocol;fail("TX7_PACKET",3);return;}
                const uint32_t index=uint32_t(header_[8])|(uint32_t(header_[9])<<8)|
                    (uint32_t(header_[10])<<16)|(uint32_t(header_[11])<<24);
                // Upstream validates CRC before sequence/padding/capacity.
                // Remember later checks without exposing their error or
                // counters before the complete packet's CRC has arrived.
                bad_sequence_=index!=expected_index;
                data_end_=12+(count_*7+7)/8;
            }
            return;
        }
        if(at<data_end_) {
            crc_=update(crc_,byte,table);
            reservoir_=uint16_t((reservoir_<<8)|byte); bits_+=8;
            // One input byte produces at most two samples; bounded work.
            while(bits_>=7 && decoded_<count_) {
                bits_-=7;
                const uint8_t symbol=uint8_t((reservoir_>>bits_)&127);
                const uint8_t sample=symbol<125?uint8_t(int(symbol)-42):
                    symbol==125?uint8_t(146):symbol==126?uint8_t(208):uint8_t(88);
                if(!bad_sequence_ && !bad_ring_ && !sink.stage(decoded_,sample)) {
                    bad_ring_=true;
                }
                ++decoded_;
            }
            if(used_==data_end_ && bits_ && (reservoir_&((1u<<bits_)-1))) {
                bad_padding_=true;
            }
            return;
        }
        received_crc_|=uint32_t(byte)<<((at-data_end_)*8);
        if(used_!=data_end_+4) return;
        if((crc_^0xffffffffu)!=received_crc_) { ++stats.crc; fail("TX7_CRC",4); return; }
        if(bad_sequence_) {++stats.sequence;fail("TX7_SEQUENCE",5);return;}
        if(header_[5]) {
            if(!sink.finish()) {++stats.overflow;fail("TX7_RING_FULL",8);return;}
            finished=true;
        }
        else {
            if(bad_padding_) {++stats.protocol;fail("TX7_PACKET",6);return;}
            if(bad_ring_ || decoded_!=count_ || !sink.commit(count_)) {
                ++stats.overflow;stats.dropped_samples+=count_;fail("TX7_RING_FULL",8);return;
            }
            expected_index+=count_; ++stats.blocks; stats.samples+=count_;
        }
        used_=matched_=discarded_=data_end_=count_=decoded_=reservoir_=bits_=0;
        crc_=0xffffffffu; received_crc_=0;
        bad_sequence_=bad_padding_=bad_ring_=false;
    }
private:
    static inline uint32_t update(uint32_t crc,uint8_t byte,const uint32_t *table) {
        return (crc>>8)^table[(crc^byte)&255];
    }
    uint8_t header_[12]={};
    uint16_t used_=0, discarded_=0, data_end_=0, count_=0, decoded_=0, reservoir_=0;
    uint8_t matched_=0, bits_=0;
    bool bad_sequence_=false,bad_padding_=false,bad_ring_=false;
    uint32_t crc_=0xffffffffu, received_crc_=0;
};
