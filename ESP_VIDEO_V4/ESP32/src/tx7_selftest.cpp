#include <cstring>
#include "tx7_selftest.h"
#include "tx7_stream.h"
#include "tx7_vectors.h"
// Unmodified upstream decoder: compare every externally visible step,
// rather than testing against a second copy of the streaming algorithm.
#include "upstream_tx7_decoder.h"

namespace {
struct Sink {
    uint8_t samples[512]={};
    size_t head=0,limit=512;
    bool ended=false,reject_finish=false;
    size_t free_samples() const {return limit-head;}
    bool stage(uint16_t at,uint8_t value) {
        if(at>=free_samples())return false;
        samples[head+at]=value;return true;
    }
    bool commit(uint16_t count) {
        if(count>free_samples())return false;
        head+=count;return true;
    }
    bool finish() {
        if(reject_finish)return false;
        ended=true;return true;
    }
};
struct ReferenceSink:Sink {
    bool enqueue(const uint8_t *values,uint16_t count) {
        if(count>free_samples())return false;
        memcpy(samples+head,values,count);head+=count;return true;
    }
};
struct Pair {
    Tx7Stream decoder;
    esp_video_tx7::Decoder reference;
    Sink sink;
    ReferenceSink reference_sink;
    bool equal=true;
    void capacity(size_t value) {sink.limit=value;reference_sink.limit=value;}
    void reject_finish() {sink.reject_finish=reference_sink.reject_finish=true;}
    bool compare() const {
        const Tx7Stats &a=decoder.stats;
        const esp_video_tx7::Stats &b=reference.stats();
        return decoder.error_code==uint8_t(reference.error()) &&
            decoder.finished==reference.finished() &&
            decoder.expected_index==reference.expectedIndex() &&
            decoder.boundary()==reference.atBoundary() &&
            a.wire_bytes==b.wireBytes && a.blocks==b.blocksAccepted &&
            a.samples==b.samplesAccepted && a.resync==b.resyncBytes &&
            a.crc==b.crcErrors && a.sequence==b.sequenceErrors &&
            a.protocol==b.protocolErrors && a.overflow==b.overflowErrors &&
            a.truncated==b.truncatedErrors && a.timeout==b.timeoutErrors &&
            sink.head==reference_sink.head && sink.ended==reference_sink.ended &&
            !memcmp(sink.samples,reference_sink.samples,sink.head);
    }
    void byte(uint8_t value,const uint32_t *table) {
        decoder.feed(value,sink,table);reference.feed(value,0,reference_sink);
        equal=equal&&compare();
    }
    template<size_t N>void feed(const uint8_t (&bytes)[N],const uint32_t *table) {
        for(uint8_t value:bytes)byte(value,table);
    }
    void end() {decoder.end_of_input();reference.finish();equal=equal&&compare();}
    bool fault(uint8_t expected) const {return equal&&decoder.error_code==expected&&sink.head==0;}
};
}

uint32_t tx7_selftest(const uint32_t *table) {
    uint32_t failed=0;
    // Eight groups retain cases=8. Every byte is compared with upstream,
    // including error precedence, numeric codes, counters and publication.
    {
        Pair p;p.feed(block256,table);p.feed(block17,table);p.feed(finish273,table);
        if(!p.equal||!p.decoder.finished||!p.sink.ended||p.sink.head!=273||
           memcmp(p.sink.samples,pcm256,256)||memcmp(p.sink.samples+256,pcm17,17))failed|=1;
    }
    {
        Pair p;p.feed(crcAndSequence,table);
        if(!p.fault(4)||p.decoder.stats.crc!=1)failed|=2;
        Pair q;q.feed(crcAndPadding,table);
        if(!q.fault(4)||q.decoder.stats.protocol||q.decoder.stats.dropped_samples)failed|=2;
        Pair r;r.capacity(0);r.feed(crcAndRing,table);
        if(!r.fault(4)||r.decoder.stats.overflow||r.decoder.stats.dropped_samples)failed|=2;
    }
    {
        Pair p;p.feed(block17,table);
        if(!p.fault(5)||p.decoder.stats.sequence!=1)failed|=4;
        Pair q;q.capacity(0);q.feed(sequenceAndPadding,table);
        if(!q.fault(5)||q.decoder.stats.protocol||q.decoder.stats.overflow||q.decoder.stats.dropped_samples)failed|=4;
        Pair r;r.capacity(0);r.feed(finish273,table);
        if(!r.fault(5)||r.sink.ended)failed|=4;
    }
    {
        Pair p;p.capacity(255);p.feed(block256,table);
        if(!p.fault(8)||p.decoder.stats.overflow!=1||p.decoder.stats.dropped_samples!=256)failed|=8;
        Pair q;q.capacity(0);q.feed(paddingOnly,table);
        if(!q.fault(6)||q.decoder.stats.protocol!=1||q.decoder.stats.overflow||q.decoder.stats.dropped_samples)failed|=8;
        Pair r;r.reject_finish();r.feed(finish0,table);
        if(!r.fault(8)||r.decoder.stats.overflow!=1||r.decoder.finished)failed|=8;
    }
    {
        Pair p;
        for(size_t i=0;i<sizeof(block256)-1;++i)p.byte(block256[i],table);
        p.end();if(!p.fault(9)||p.decoder.stats.truncated!=1)failed|=16;
        Pair q;q.feed(block256,table);q.end();
        if(!q.equal||q.decoder.error_code!=12||q.decoder.stats.protocol!=1||q.decoder.stats.truncated)failed|=16;
    }
    {
        Pair p;p.feed(finish0,table);p.byte(0,table);
        if(!p.fault(13)||!p.sink.ended||p.decoder.stats.protocol!=1)failed|=32;
    }
    {
        Pair p;for(unsigned i=0;i<513;++i)p.byte(0,table);
        if(!p.fault(1)||p.decoder.stats.resync!=513||p.decoder.stats.protocol!=1)failed|=64;
    }
    {
        Pair p;p.byte(0x54,table);p.byte(0x54,table);p.feed(block256,table);
        if(!p.equal||p.decoder.error||p.sink.head!=256||p.decoder.stats.resync!=2||memcmp(p.sink.samples,pcm256,256))failed|=128;
    }
    return failed;
}
