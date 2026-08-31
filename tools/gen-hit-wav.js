// 生成《弹珠工坊》弹珠撞击音效：44.1kHz / 16-bit 单声道 WAV（高频清脆"叮咚"铃声）
// 运行: node tools/gen-hit-wav.js  → 输出 assets/audio/hit.wav
const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 44100;
const DURATION = 0.5; // 总时长 0.5s（叮 + 咚）
const NUM_SAMPLES = Math.floor(SAMPLE_RATE * DURATION);
const NUM_CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

// 两个音色：t=0 起"叮"(C6 高频清脆)，t=0.18s 起"咚"(G5 稍低)
const DING = { start: 0.0, freq: 1046.5, amp: 0.9, decay: 14 };
const DONG = { start: 0.18, freq: 784.0, amp: 0.8, decay: 12 };

function sample(t) {
    let s = 0;
    for (const note of [DING, DONG]) {
        const lt = t - note.start;
        if (lt < 0) continue;
        // 指数衰减包络 + 基频与少量泛音，形成清脆铃声
        const env = Math.exp(-note.decay * lt);
        const partials =
            Math.sin(2 * Math.PI * note.freq * lt) * 1.0 +
            Math.sin(2 * Math.PI * note.freq * 2.0 * lt) * 0.3 +
            Math.sin(2 * Math.PI * note.freq * 2.6176 * lt) * 0.15 +
            Math.sin(2 * Math.PI * note.freq * 3.2367 * lt) * 0.06;
        s += note.amp * env * partials;
    }
    // 软削波归一化，避免削顶爆音
    return 0.45 * Math.tanh(s);
}

// 生成 int16 采样
const samples = new Int16Array(NUM_SAMPLES);
for (let i = 0; i < NUM_SAMPLES; i++) {
    const v = Math.max(-1, Math.min(1, sample(i / SAMPLE_RATE)));
    samples[i] = Math.round(v * 32767);
}

// 组装 WAV（RIFF / 16-bit PCM / 单声道）
const dataSize = samples.length * 2;
const buffer = Buffer.alloc(44 + dataSize);
buffer.write('RIFF', 0);
buffer.writeUInt32LE(36 + dataSize, 4);
buffer.write('WAVE', 8);
buffer.write('fmt ', 12);
buffer.writeUInt32LE(16, 16); // fmt 块大小
buffer.writeUInt16LE(1, 20); // PCM
buffer.writeUInt16LE(NUM_CHANNELS, 22);
buffer.writeUInt32LE(SAMPLE_RATE, 24);
buffer.writeUInt32LE((SAMPLE_RATE * NUM_CHANNELS * BITS_PER_SAMPLE) / 8, 28); // 字节率
buffer.writeUInt16LE((NUM_CHANNELS * BITS_PER_SAMPLE) / 8, 32); // 块对齐
buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);
buffer.write('data', 36);
buffer.writeUInt32LE(dataSize, 40);
for (let i = 0; i < samples.length; i++) {
    buffer.writeInt16LE(samples[i], 44 + i * 2);
}

const outFile = path.join(__dirname, '..', 'assets', 'audio', 'hit.wav');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, buffer);
console.log(
    `已生成 ${outFile} (${buffer.length} bytes, ${DURATION}s, ${SAMPLE_RATE / 1000}kHz ${BITS_PER_SAMPLE}-bit mono)`
);
