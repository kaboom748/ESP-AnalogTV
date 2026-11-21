/* ESP_VIDEO_V4 serial layer for ESP32-C6.
 * Protocol: kaboom748/ESP-AnalogTV, ESP_VIDEO_V3 at 050aa17.
 * Native C6 radio and polled UART0: kaboom748/ESP-AnalogRadio, CB_V14.
 * RF firmware ancestry: Copyright (c) 2026 SP8ESA, MIT; see NOTICE.
 * This port is distributed under GPL-3.0-or-later; see LICENSE.
 */
#include <algorithm>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include "driver/uart.h"
#include "esp_attr.h"
#include "esp_log.h"
#include "esp_cpu.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "hal/uart_ll.h"
#include "soc/uart_reg.h"
#include "soc/uart_struct.h"
#include "c6_radio.h"
#include "c6_rx.h"
#include "c6_tx.h"
#include "tx7_stream.h"
#include "tx7_selftest.h"

namespace {
constexpr uart_port_t Port=UART_NUM_0;
constexpr uint32_t Baud=1500000, CpuHz=160000000;
constexpr uint32_t DefaultFrequency=2442312500u, MinFrequency=2401000000u, MaxFrequency=2482500000u;
constexpr uint32_t StartLevel=8192, ArmTimeoutMs=1200, InputTimeoutMs=150;
constexpr size_t Payload=128, Header=10, Frame=138, MaxFrame=142, RxSlots=118;
constexpr uint32_t UartErrors=UART_RXFIFO_OVF_INT_RAW_M|UART_FRM_ERR_INT_RAW_M|UART_PARITY_ERR_INT_RAW_M;
uint32_t crc_table[256];
uint8_t wire_version=3, apwr=63;
uint32_t pace=150000, frequency=DefaultFrequency;
int32_t fine=0;
unsigned profile=0;
bool receive_requested=false, receiving=false, transmitting=false, rf_ok=false;
const char *const profile_names[]={"HQ","ROBUST","MONO"};
const uint32_t profile_rates[]={120000,96000,48000};
uint8_t rx_queue[RxSlots][Frame]
    DRAM_ATTR __attribute__((aligned(16)));
uint16_t rx_read=0,rx_write=0,rx_send=0,rx_fill=0;
uint32_t rx_wire_crc=0xffffffffu;
uint32_t rx_pace_deadline=0,rx_pace_remainder=0;
bool rx_control_pending=false;
uint8_t rx_control_byte=0;
struct WireStats {
    uint32_t bytes=0,frames=0,drops=0,max_queue=0,max_fifo=0,fifo_batches=0;
} rx_wire,last_rx_wire;
c6_rx_stats_t last_rx={};
bool last_rx_valid=false;
uint8_t last_rx_version=3;
uint32_t last_rx_pace=150000;
struct TransportStats {
    uint32_t wire=0,accepted=0,uart_overflows=0,uart_frames=0,uart_parity=0;
    uint32_t drops=0,reserved=0;
} tx_transport,last_tx_transport;
c6_tx_stats_t last_tx={};
Tx7Stats last_tx7={};
bool last_tx_valid=false,last_used_tx7=false;
uint8_t last_tx7_error=0;
Tx7Stream tx7;
bool protected_tx=false;
const char *tx_error=nullptr;
uint32_t tx_last_cycles=0,tx_watch=0;
uint64_t tx_arm_at=0,tx_last_ready=0;
bool tx_received=false;

inline uint32_t IRAM_ATTR cycles() { return esp_cpu_get_cycle_count(); }
inline uint32_t IRAM_ATTR crc_byte(uint32_t crc,uint8_t byte) { return (crc>>8)^crc_table[(crc^byte)&255]; }
uint16_t wire_size() { return Frame+(wire_version==4?4:0); }
void write_bytes(const void *data,size_t size) {
    const auto *bytes=static_cast<const uint8_t *>(data);
    while(size) {
        const unsigned room=uart_ll_get_txfifo_len(&UART0);
        if(!room)continue;
        const unsigned count=std::min(size,size_t(room));
        uart_ll_write_txfifo(&UART0,bytes,count);
        bytes+=count;
        size-=count;
    }
}
void flush_output() { while(!uart_ll_is_tx_idle(&UART0)) {} }
void flush_input() {
    uart_ll_rxfifo_rst(&UART0);
    uart_ll_clr_intsts_mask(&UART0,UINT32_MAX);
}
void line(const char *format,...) {
    char data[512]; va_list args;va_start(args,format);
    const int length=vsnprintf(data,sizeof(data),format,args);va_end(args);
    if(length>0) write_bytes(data,std::min(size_t(length),sizeof(data)-1));
}
void crc_init() {
    for(unsigned i=0;i<256;++i) {
        uint32_t c=i;
        for(unsigned bit=0;bit<8;++bit) {
            c=(c>>1)^((c&1)?0xedb88320u:0u);
        }
        crc_table[i]=c;
    }
}
void stop_rx() {
    if(!receiving) return;
    c6_rx_stop();c6_rx_get_stats(&last_rx);
    last_rx_valid=true;last_rx_version=wire_version;last_rx_pace=pace;
    // Finish an already started packet so following text is never its payload.
    if(rx_send && rx_read!=rx_write) {
        uint8_t packet[MaxFrame];memcpy(packet,rx_queue[rx_read],Frame);
        uint32_t crc=0xffffffffu;
        for(size_t i=0;i<Frame;++i) {
            crc=crc_byte(crc,packet[i]);
        }
        crc^=0xffffffffu;
        for(unsigned i=0;i<4;++i) {
            packet[Frame+i]=uint8_t(crc>>(i*8));
        }
        const size_t remaining=wire_size()-rx_send;
        write_bytes(packet+rx_send,remaining);
        rx_wire.bytes+=remaining;++rx_wire.frames;
    }
    last_rx_wire=rx_wire;
    receiving=false;rx_read=rx_write=rx_send=rx_fill=0;
    flush_output();
}
bool start_rx() {
    if(!receive_requested || transmitting) return false;
    stop_rx();
    if(!rf_ok || c6_rx_start(frequency,fine,profile)!=ESP_OK) {
        receive_requested=false;c6_radio_idle();line("ERR RX_RF\n");return false;
    }
    rx_read=rx_write=rx_send=rx_fill=0;rx_wire_crc=0xffffffffu;
    rx_pace_remainder=0;rx_pace_deadline=cycles();rx_wire=WireStats();receiving=true;
    line("OK RX %lu %lu %s\n",(unsigned long)c6_radio_frequency_hz(),
        (unsigned long)profile_rates[profile],profile_names[profile]);
    flush_output();return true;
}
void IRAM_ATTR append_rx(uint32_t index,uint8_t value,uint16_t strength,void *) {
    if(!rx_fill) {
        const uint16_t next=(rx_write+1)%RxSlots;
        if(next==rx_read) { ++rx_wire.drops;return; }
        uint8_t *frame=rx_queue[rx_write];frame[0]='M';frame[1]='P';frame[2]='X';frame[3]='0'+wire_version;
        for(unsigned i=0;i<4;++i) {
            frame[4+i]=uint8_t(index>>(i*8));
        }
        frame[8]=strength;frame[9]=strength>>8;
    }
    rx_queue[rx_write][Header+rx_fill++]=value;
    if(rx_fill==Payload) {
        rx_fill=0;rx_write=(rx_write+1)%RxSlots;
        const uint32_t depth=(rx_write+RxSlots-rx_read)%RxSlots;
        rx_wire.max_queue=std::max(rx_wire.max_queue,depth);
    }
}
bool IRAM_ATTR native_rx_pump(void *) {
    // Keep the first command byte for the parser when the acquisition exits.
    if(uart_ll_get_rxfifo_len(&UART0)) {
        uart_ll_read_rxfifo(&UART0,&rx_control_byte,1);
        rx_control_pending=true;return false;
    }
    const uint32_t now=cycles();
    if(rx_read==rx_write) {rx_pace_deadline=now;rx_pace_remainder=0;return true;}
    if(pace && int32_t(now-rx_pace_deadline)<0) return true;
    const uint32_t fifo_free=uart_ll_get_txfifo_len(&UART0);
    rx_wire.max_fifo=std::max(rx_wire.max_fifo,uint32_t(UART_LL_FIFO_DEF_LEN)-fifo_free);
    if(!fifo_free) return true;
    uint8_t byte;
    if(rx_send<Frame) {
        byte=rx_queue[rx_read][rx_send];
        if(wire_version==4)rx_wire_crc=crc_byte(rx_wire_crc,byte);
    } else {
        byte=uint8_t((rx_wire_crc^0xffffffffu)>>(8u*(rx_send-Frame)));
    }
    uart_ll_write_txfifo(&UART0,&byte,1);
    ++rx_send;++rx_wire.bytes;++rx_wire.fifo_batches;
    if(pace==150000u) {
        // A 160 MHz clock needs one extra cycle for two of every three bytes.
        rx_pace_deadline+=CpuHz/150000u;
        rx_pace_remainder+=CpuHz%150000u;
        if(rx_pace_remainder>=150000u) {rx_pace_remainder-=150000u;++rx_pace_deadline;}
    } else if(pace==160000u) {
        rx_pace_deadline+=CpuHz/160000u;
    }
    const unsigned size=wire_version==4?MaxFrame:Frame;
    if(rx_send==size) {
        rx_send=0;rx_wire_crc=0xffffffffu;rx_read=(rx_read+1)%RxSlots;++rx_wire.frames;
    }
    return true;
}
void poll_rx() {
    c6_rx_run(append_rx,native_rx_pump,nullptr);
}
struct TxSink {
    inline size_t free_samples() const { return c6_tx_free_samples(); }
    inline bool stage(uint16_t offset,uint8_t sample) { return c6_tx_stage(offset,sample); }
    inline bool commit(uint16_t count) {
        const bool ok=c6_tx_commit(count);
        if(ok) {
            tx_transport.accepted+=count;
        }
        return ok;
    }
    inline bool finish() { c6_tx_finish(); return true; }
} tx_sink;

inline void IRAM_ATTR tx_byte(uint8_t byte) {
    ++tx_transport.wire;tx_received=true;tx_last_cycles=cycles();
    if(protected_tx) {
        tx7.feed(byte,tx_sink,crc_table);
        if(tx7.error) { tx_error=tx7.error;c6_tx_stop(); }
    } else {
        if(byte==0x80) {byte=0;++tx_transport.reserved;}
        if(c6_tx_feed(&byte,1)==1)++tx_transport.accepted;
        else ++tx_transport.drops;
    }
}
void IRAM_ATTR check_tx_uart() {
    const uint32_t errors=uart_ll_get_intraw_mask(&UART0)&UartErrors;
    if(errors) {
        if(errors&UART_RXFIFO_OVF_INT_RAW_M)++tx_transport.uart_overflows;
        if(errors&UART_FRM_ERR_INT_RAW_M)++tx_transport.uart_frames;
        if(errors&UART_PARITY_ERR_INT_RAW_M)++tx_transport.uart_parity;
        uart_ll_clr_intsts_mask(&UART0,errors);
        if(protected_tx) {tx_error="TX7_UART";c6_tx_stop();}
    }
}
void IRAM_ATTR tx_pump(void *) {
    // The modulation loop masks interrupts, so handle one FIFO byte per poll.
    if(uart_ll_get_rxfifo_len(&UART0)) {
        uint8_t byte;uart_ll_read_rxfifo(&UART0,&byte,1);tx_byte(byte);
    }
    if((++tx_watch&63u)!=0) return;
    check_tx_uart();
    if(uint32_t(cycles()-tx_last_cycles)>=CpuHz/1000*InputTimeoutMs) {
        if(protected_tx && !tx7.finished) {tx7.end_of_input();tx_error=tx7.error;}
        c6_tx_stop();
    }
}
void finish_tx() {
    c6_tx_stop();c6_tx_get_stats(&last_tx);last_tx_transport=tx_transport;
    if(!last_tx.samples)last_tx.min_queue=0;
    last_tx7=tx7.stats;last_tx7_error=tx7.error_code;last_tx_valid=true;last_used_tx7=protected_tx;
    transmitting=false;
    const char *backend_error=c6_tx_fault();
    if(!tx_error && backend_error) {
        tx_error=backend_error;
    }
    if(backend_error && !strcmp(backend_error,"TX7_UNDERRUN") && !last_tx7_error)last_tx7_error=11;
    if(tx_error)line("ERR %s\n",tx_error);
    // Drop trailing samples from the ended stream before interpreting commands.
    flush_input();
    if(tx_error) {vTaskDelay(pdMS_TO_TICKS(120));flush_input();}
    if(receive_requested)start_rx();
}
void begin_tx(uint8_t requested,bool use_tx7) {
    if(!receive_requested) {line("ERR SELECT_RX\n");return;}
    stop_rx();
    if(!rf_ok || !c6_tx_start(frequency,requested)) {line("ERR TX_RF\n");start_rx();return;}
    apwr=requested;protected_tx=use_tx7;c6_tx_set_protected(use_tx7);tx7.reset();
    tx_transport=TransportStats();tx_error=nullptr;tx_received=false;tx_watch=0;
    uint8_t boundary[MaxFrame]={};write_bytes(boundary,wire_size());flush_output();
    flush_input();
    transmitting=true;tx_arm_at=esp_timer_get_time();tx_last_ready=0;tx_last_cycles=cycles();
}
void poll_tx_arming() {
    check_tx_uart();
    const unsigned count=uart_ll_get_rxfifo_len(&UART0);
    for(unsigned i=0;i<count && !tx_error;++i) {
        uint8_t byte;uart_ll_read_rxfifo(&UART0,&byte,1);tx_byte(byte);
    }
    if(tx_error) {finish_tx();return;}
    const uint64_t now=esp_timer_get_time();
    if(!tx_received && (!tx_last_ready || now-tx_last_ready>=25000)) {
        const uint8_t ready[4]={0xef,0xef,0xef,0xef};write_bytes(ready,sizeof(ready));tx_last_ready=now;
    }
    if(c6_tx_queued_samples()>=StartLevel || (protected_tx && tx7.finished && c6_tx_queued_samples())) {
        flush_output();
        c6_tx_run(tx_pump,nullptr);
        finish_tx();return;
    }
    if(protected_tx && tx7.finished && !c6_tx_queued_samples()) {finish_tx();return;}
    const uint32_t timeout=tx_received?InputTimeoutMs:ArmTimeoutMs;
    if((!tx_received && now-tx_arm_at>=uint64_t(timeout)*1000) ||
        (tx_received && uint32_t(cycles()-tx_last_cycles)>=CpuHz/1000*timeout)) {
        if(protected_tx && tx_received) {tx7.end_of_input();tx_error=tx7.error;}
        finish_tx();return;
    }
}
bool unsigned_value(const char *text,uint32_t &out) {
    if(!text || !*text) {
        return false;
    }
    uint64_t number=0;
    for(const char *p=text;*p;++p) {
        if(*p<'0'||*p>'9') {
            return false;
        }
        number=number*10+(*p-'0');
        if(number>UINT32_MAX) {
            return false;
        }
    }
    out=number;return true;
}
bool signed_value(const char *text,int32_t &out) {
    if(!text || !*text) {
        return false;
    }
    bool negative=*text=='-';
    if(negative || *text=='+') {
        ++text;
    }
    uint32_t number;
    if(!unsigned_value(text,number)||number>50000) {
        return false;
    }
    out=negative?-int32_t(number):int32_t(number);return true;
}
void diagnostics() {
    if(receive_requested) {line("ERR STOP_FIRST\n");return;}
    // Native acquisition measures lateness against its fixed IQ deadline.
    const uint32_t late=last_rx.max_late_cycles;
    line("OK DIAG RX n=%lu inv=%lu skip=%lu tout=%lu drop=%lu late=%lu\n",
        (unsigned long)last_rx.samples,(unsigned long)last_rx.invalid,(unsigned long)last_rx.skipped,
        (unsigned long)last_rx.timeouts,(unsigned long)last_rx_wire.drops,(unsigned long)late);
    line("OK DIAG UART bytes=%lu frames=%lu fifo=%lu wire=%u pace=%lu valid=%u\n",
        (unsigned long)last_rx_wire.bytes,(unsigned long)last_rx_wire.frames,(unsigned long)last_rx_wire.max_fifo,last_rx_version,(unsigned long)last_rx_pace,last_rx_valid);
    line("OK DIAG RXQUEUE frames=%lu capacity=%u pcm=%u\n",(unsigned long)last_rx_wire.max_queue,unsigned(RxSlots-1),unsigned((RxSlots-1)*Payload));
    line("OK DIAG TX mode=%s n=%lu wire=%lu ov=%lu frame=%lu parity=%lu drop=%lu under=%lu zero=%lu reserved=%lu skip=%lu qmin=%lu qmax=%lu valid=%u\n",
        last_used_tx7?"TX7":"RAW",(unsigned long)last_tx_transport.accepted,(unsigned long)last_tx_transport.wire,
        (unsigned long)last_tx_transport.uart_overflows,(unsigned long)last_tx_transport.uart_frames,
        (unsigned long)last_tx_transport.uart_parity,(unsigned long)(last_tx_transport.drops+last_tx7.dropped_samples),
        (unsigned long)last_tx.underruns,(unsigned long)last_tx.zero_samples,(unsigned long)last_tx_transport.reserved,
        (unsigned long)last_tx.timer_skips,(unsigned long)last_tx.min_queue,(unsigned long)last_tx.max_queue,last_tx_valid);
    line("OK DIAG TX7 blocks=%lu crc=%lu seq=%lu proto=%lu overflow=%lu trunc=%lu timeout=%lu underrun=%lu error=%u\n",
        (unsigned long)last_tx7.blocks,(unsigned long)last_tx7.crc,(unsigned long)last_tx7.sequence,
        (unsigned long)last_tx7.protocol,(unsigned long)last_tx7.overflow,(unsigned long)last_tx7.truncated,
        (unsigned long)last_tx7.timeout,(unsigned long)(last_used_tx7?last_tx.underruns:0),last_tx7_error);
    line("OK DIAG END\n");
}
void hardware_diagnostics() {
    if(receive_requested) {line("ERR STOP_FIRST\n");return;}
    line("OK DIAG UARTBATCH count=%lu bytes=%lu max_segment=1\n",
        (unsigned long)last_rx_wire.fifo_batches,(unsigned long)last_rx_wire.bytes);
    line("OK DIAG C6 cpu=%lu rx_lag_bytes=%lu rx_overrun_events=%lu rx_iq_skipped=%lu iq_window=%lu tx_late_cycles=%lu tx_late_slots=%lu tx_startup_cycles=%lu tx_dco_restores=%lu\n",
        (unsigned long)CpuHz,(unsigned long)last_rx.max_lag_bytes,(unsigned long)last_rx.overruns,
        (unsigned long)last_rx.skipped,(unsigned long)last_rx.window_lsb,
        (unsigned long)last_tx.max_late_cycles,(unsigned long)last_tx.late_slots,
        (unsigned long)last_tx.startup_cycles,(unsigned long)last_tx.startup_dco_changes);
    line("OK DIAG C6RX peak_adc=%lu iq_edge_codes=%lu iq_edge_windows=%lu pcm_clipped=%lu fm_unwraps=%lu frequency_hz=%ld dc_i_adc=%ld dc_q_adc=%ld disc_min_hz=%ld disc_max_hz=%ld\n",
        (unsigned long)last_rx.peak,(unsigned long)last_rx.iq_edge_codes,
        (unsigned long)last_rx.iq_edge_windows,
        (unsigned long)last_rx.pcm_clipped,(unsigned long)last_rx.fm_unwraps,(long)last_rx.frequency_hz,
        (long)last_rx.dc_i_adc,(long)last_rx.dc_q_adc,
        (long)last_rx.discriminator_min_hz,(long)last_rx.discriminator_max_hz);
    line("OK DIAG C6PERF iq_window_samples=%lu calls=%lu cycles=%llu iq=%llu cycles_per_iq=%lu max_read_cycles=%lu\n",
        (unsigned long)last_rx.iq_window_samples,(unsigned long)last_rx.read_calls,
        (unsigned long long)last_rx.read_cycles,(unsigned long long)last_rx.profiled_iq,
        (unsigned long)last_rx.mean_cycles_per_iq,(unsigned long)last_rx.max_read_cycles);
    line("OK DIAG C6EST source_hz=%lu iq_hz=%lu window=%lu max_late_cycles=%lu late_slots=%lu clear_high=%lu\n",
        (unsigned long)last_rx.source_rate_hz,(unsigned long)last_rx.iq_rate_hz,
        (unsigned long)last_rx.iq_window_samples,(unsigned long)last_rx.max_late_cycles,
        (unsigned long)last_rx.late_slots,(unsigned long)last_rx.clear_still_high);
    line("OK DIAGHW END\n");
}
void serial_test(char writer,uint32_t frames) {
    receive_requested=false;stop_rx();c6_radio_idle();
    line("OK TEST %c %lu WIRE %u PACE %lu\n",writer,(unsigned long)frames,wire_version,(unsigned long)pace);
    flush_output();
    const uint64_t origin=esp_timer_get_time();uint32_t completed=0,bytes=0;
    for(uint32_t frame=0;frame<frames;++frame) {
        if(uart_ll_get_rxfifo_len(&UART0)) {
            break;
        }
        const uint64_t due=origin+uint64_t(frame)*wire_size()*1000000/129375;
        while(uint64_t(esp_timer_get_time())<due) {if(due-esp_timer_get_time()>1500)vTaskDelay(1);}
        uint8_t packet[MaxFrame];packet[0]='M';packet[1]='P';packet[2]='X';packet[3]='0'+wire_version;
        const uint32_t index=frame*Payload;
        for(unsigned i=0;i<4;++i) {
            packet[4+i]=index>>(8*i);
        }
        packet[8]=0x3c;packet[9]=0x5a;
        for(unsigned i=0;i<Payload;++i){const uint32_t n=index+i;packet[Header+i]=((n*73+19)^(n>>3)^(n>>11))&255;}
        uint32_t crc=0xffffffffu;
        for(unsigned i=0;i<Frame;++i) {
            crc=crc_byte(crc,packet[i]);
        }
        crc^=0xffffffffu;
        for(unsigned i=0;i<4;++i) {
            packet[Frame+i]=crc>>(8*i);
        }
        if(writer=='S') {
            write_bytes(packet,wire_size());
        } else {
            for(unsigned at=0;at<wire_size();++at) {
                while(!uart_ll_get_txfifo_len(&UART0)) {}
                uart_ll_write_txfifo(&UART0,packet+at,1);
            }
        }
        ++completed;bytes+=wire_size();
    }
    flush_output();
    line("\nOK TEST DONE frames=%lu bytes=%lu\n",(unsigned long)completed,(unsigned long)bytes);
}
void command(char *text) {
    char *save=nullptr;
    const char *name=strtok_r(text," \t",&save);
    if(!name) {
        return;
    }
    const char *value=strtok_r(nullptr," \t",&save);
    if(!value) {
        if(!strcmp(name,"STATUS")) {line("OK STATUS CB_FM_STEREO 4\n");return;}
        if(!strcmp(name,"TX7?")) {line("OK TX7 1 BLOCK 256\n");return;}
        if(!strcmp(name,"SELFTEST")) {
            const uint32_t result=tx7_selftest(crc_table);
            line("%s SELFTEST TX7 cases=8 bitmap=%lu\n",result?"ERR":"OK",(unsigned long)result);return;
        }
        if(!strcmp(name,"STOP")) {receive_requested=false;stop_rx();c6_radio_idle();wire_version=3;pace=150000;line("OK STOP\n");return;}
        if(!strcmp(name,"INFO")) {line("OK INFO LINK 1 BAUD %lu WIRE %u PACE %lu CRC32 IEEE TX7 1\n",(unsigned long)Baud,wire_version,(unsigned long)pace);return;}
        if(!strcmp(name,"HWINFO")) {line("OK HWINFO TARGET ESP32-C6 UART0 TX16 RX17 CPU %lu RF %u\n",(unsigned long)CpuHz,rf_ok);return;}
        if(!strcmp(name,"DIAG")) {diagnostics();return;}
        if(!strcmp(name,"DIAGHW")) {hardware_diagnostics();return;}
    }
    if(!strcmp(name,"WIRE") || !strcmp(name,"PACE")) {
        const bool wire=!strcmp(name,"WIRE");uint32_t selected;
        const bool spelling_ok=value && (wire?(!strcmp(value,"3")||!strcmp(value,"4")):
            (!strcmp(value,"0")||!strcmp(value,"150000")||!strcmp(value,"160000")));
        if(!spelling_ok||!unsigned_value(value,selected)||strtok_r(nullptr," \t",&save)) {line("ERR %s\n",name);return;}
        if(receive_requested){line("ERR STOP_FIRST\n");return;}
        if(wire) {
            wire_version=selected;
        } else {
            pace=selected;
        }
        line("OK %s %lu\n",name,(unsigned long)selected);return;
    }
    if(!strcmp(name,"TEST")) {
        const char *count=strtok_r(nullptr," \t",&save);uint32_t frames;
        if(!value||strlen(value)!=1||(value[0]!='S'&&value[0]!='D')||!unsigned_value(count,frames)||frames<1||frames>30000||strtok_r(nullptr," \t",&save)){line("ERR TEST_ARGS\n");return;}
        if(receive_requested){line("ERR STOP_FIRST\n");return;}serial_test(value[0],frames);return;
    }
    if(!strcmp(name,"TX") || !strcmp(name,"TX7")) {
        uint32_t requested;if(!unsigned_value(value,requested)||requested>191||strtok_r(nullptr," \t",&save)){line("ERR TX_APWR\n");return;}
        begin_tx(requested,!strcmp(name,"TX7"));return;
    }
    if(strcmp(name,"RX") || !value){line("ERR COMMAND\n");return;}
    uint32_t selected;if(!unsigned_value(value,selected)){line("ERR FREQUENCY\n");return;}
    if(selected>=1&&selected<=13)selected=(2407u+5u*selected)*1000000u+312500u;
    if(selected<MinFrequency||selected>MaxFrequency){line("ERR FREQUENCY\n");return;}
    const char *mode=strtok_r(nullptr," \t",&save);unsigned selected_profile=3;
    for(unsigned i=0;i<3;++i) {
        if(mode&&!strcmp(mode,profile_names[i])) {
            selected_profile=i;
        }
    }
    if(selected_profile==3){line("ERR MODE\n");return;}
    const char *offset=strtok_r(nullptr," \t",&save);int32_t selected_fine=0;
    if((offset&&!signed_value(offset,selected_fine))||strtok_r(nullptr," \t",&save)){line("ERR FINE\n");return;}
    frequency=selected;profile=selected_profile;fine=selected_fine;receive_requested=true;start_rx();
}
} // namespace

extern "C" void esp_analogav_run() {
    esp_log_level_set("*",ESP_LOG_NONE);crc_init();
    uart_config_t config={};config.baud_rate=Baud;config.data_bits=UART_DATA_8_BITS;
    config.parity=UART_PARITY_DISABLE;config.stop_bits=UART_STOP_BITS_1;config.flow_ctrl=UART_HW_FLOWCTRL_DISABLE;
    // Match the known polled UART0 setup of the C6 CB firmware.
    config.source_clk=UART_SCLK_PLL_F80M;
    if(uart_param_config(Port,&config)!=ESP_OK ||
       uart_set_pin(Port,16,17,UART_PIN_NO_CHANGE,UART_PIN_NO_CHANGE)!=ESP_OK) return;
    uart_ll_disable_intr_mask(&UART0,UINT32_MAX);
    flush_input();
    rf_ok=c6_radio_init()==ESP_OK && c6_tx_init();c6_radio_idle();
    char text[48]={};size_t length=0;bool invalid=false;int64_t last_input=0;
    for(;;) {
        if(transmitting) {poll_tx_arming();continue;}
        uint8_t byte=0;
        bool got=false;
        if(rx_control_pending) {
            byte=rx_control_byte;rx_control_pending=false;got=true;
        } else if(uart_ll_get_rxfifo_len(&UART0)) {
            uart_ll_read_rxfifo(&UART0,&byte,1);got=true;
        }
        if(got) {
            // A command interrupts RX without consuming bytes from its parser.
            if(receiving) {
                stop_rx();
            }
            last_input=esp_timer_get_time();
            if(byte==0xa5 && !length && !invalid){begin_tx(apwr,false);continue;}
            if(byte=='\r')continue;
            if(byte=='\n') {
                if(invalid)line("ERR COMMAND\n");else {text[length]=0;command(text);}
                length=0;invalid=false;
                if(receive_requested&&!receiving&&!transmitting)start_rx();
            } else if((byte=='\t'||(byte>=32&&byte<=126))&&length<sizeof(text)-1)text[length++]=byte;
            else invalid=true;
        } else if(length||invalid) {
            if(esp_timer_get_time()-last_input>=120000){length=0;invalid=false;if(receive_requested)start_rx();}
        } else if(receive_requested) {
            // A standalone carriage return is ignored by the ESP8266 parser.
            // Resume reception once there is no partial command to finish.
            if(receiving)poll_rx();
            else start_rx();
        } else {
            vTaskDelay(1);
        }
    }
}
