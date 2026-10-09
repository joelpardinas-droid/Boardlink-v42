// Module: AI Meeting Transcription (whisper.cpp)
const { login } = require('./helpers');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('transcriptionService.transcribe', () => {
    test('reports clearly when the whisper.cpp program is missing', async () => {
        process.env.WHISPER_BIN = '/nonexistent/whisper-cli';
        jest.resetModules();
        const { transcribe } = require('../services/transcriptionService');
        const wav = path.join(os.tmpdir(), 'bl-test.wav');
        fs.writeFileSync(wav, Buffer.alloc(44));
        await expect(transcribe(wav)).rejects.toThrow(/whisper\.cpp binary not found/);
    });
});

describe('Transcription page', () => {
    test('the Board Secretary can open it', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get('/meeting/transcription').set('X-Forwarded-For', ip);
        expect(res.statusCode).toBe(200);
    });
    test('a Trustee cannot', async () => {
        const { agent, ip } = await login('trustee');
        const res = await agent.get('/meeting/transcription').set('X-Forwarded-For', ip);
        expect(res.statusCode).toBe(302);
    });
});
