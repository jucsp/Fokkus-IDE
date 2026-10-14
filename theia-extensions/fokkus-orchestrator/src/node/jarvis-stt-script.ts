/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Script de transcripción local de Jarvis (Issue #27). Va embebido en el backend y se pasa a
 * `python3 -` por stdin: el backend de las aplicaciones se empaqueta con esbuild (y en Electron
 * dentro de un asar), así que una ruta a un `.py` relativa a `__dirname` no existiría en runtime.
 */
export const JARVIS_STT_SCRIPT = `#!/usr/bin/env python3
"""Transcripción local de audio para Fokkus Jarvis (Issue #27).

Decodifica un archivo de audio a PCM float32 mono 16 kHz con ffmpeg (evitando
las incompatibilidades de PyAV con Python 3.14) y lo transcribe con
faster-whisper (modelo \`base\` en CPU/int8). Imprime la transcripción —o el
error— como JSON en stdout.

Uso:
    stt_transcribe.py <audio_path> [lang]

\`lang\` es el código ISO 639-1 del idioma (por defecto 'es'). Si llega un código
compuesto ('es-ES') se conserva solo la parte del idioma ('es').
"""

import json
import subprocess
import sys


def decode_audio(audio_path):
    """Decodifica \`audio_path\` con ffmpeg y devuelve un array numpy float32 mono 16 kHz."""
    proc = subprocess.run(
        ['ffmpeg', '-i', audio_path, '-f', 'f32le', '-ar', '16000', '-ac', '1', '-'],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False
    )
    if proc.returncode != 0:
        raise RuntimeError('ffmpeg no pudo decodificar el audio')
    import numpy as np
    return np.frombuffer(proc.stdout, dtype=np.float32)


def load_model():
    """Carga faster-whisper en CPU con cuantización int8: el modelo \`base\` tiene mucha más
    precisión en español que \`tiny\` y tarda casi lo mismo (<0.5 s por fragmento)."""
    from faster_whisper import WhisperModel
    return WhisperModel('base', device='cpu', compute_type='int8')


def transcribe(audio_path, lang):
    """Devuelve el texto transcrito (segmentos unidos por espacios, sin espacios de sobra)."""
    audio_array = decode_audio(audio_path)
    model = load_model()
    segments, _info = model.transcribe(audio_array, language=lang, beam_size=5, vad_filter=True)
    return ' '.join(segment.text.strip() for segment in segments).strip()


def main():
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'uso: stt_transcribe.py <audio_path> [lang]'}))
        return 1
    audio_path = sys.argv[1]
    lang = sys.argv[2].split('-')[0].lower() if len(sys.argv) > 2 else 'es'
    try:
        text = transcribe(audio_path, lang)
        print(json.dumps({'text': text}))
        return 0
    except Exception as error:  # noqa: BLE001 - el error se informa al llamador por JSON
        print(json.dumps({'error': str(error)}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
`;

/** Tope de la transcripción local: la primera ejecución descarga el modelo `base` (~145 MB). */
export const JARVIS_STT_TIMEOUT_MS = 3 * 60 * 1000;

/** Resultado del script: `{"text": "..."}` o `{"error": "..."}` en la última línea de stdout. */
export interface JarvisSttOutput {
    text?: string;
    error?: string;
}

/**
 * Interpreta la salida del script. Toma la última línea JSON (uv o faster-whisper pueden escribir
 * avisos antes) y devuelve `undefined` si no hay ninguna.
 */
export function parseJarvisSttOutput(output: string): JarvisSttOutput | undefined {
    const lines = output.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith('{'));
    for (let i = lines.length - 1; i >= 0; i--) {
        try {
            const parsed: unknown = JSON.parse(lines[i]);
            if (parsed && typeof parsed === 'object') {
                const { text, error } = parsed as { text?: unknown; error?: unknown };
                return {
                    text: typeof text === 'string' ? text : undefined,
                    error: typeof error === 'string' ? error : undefined
                };
            }
        } catch {
            // Línea que empieza por '{' pero no es JSON: se prueba la anterior.
        }
    }
    return undefined;
}

/** faster-whisper espera un código ISO 639-1 ('es'); 'es-ES' se reduce a 'es'. */
export function normalizeSttLanguage(lang?: string): string {
    const code = (lang || 'es').trim().split('-')[0].toLowerCase();
    return /^[a-z]{2}$/.test(code) ? code : 'es';
}

/** Extensión del contenedor de audio a partir del `mimeType` del MediaRecorder. */
export function inferAudioExtension(mimeType: string): string {
    switch ((mimeType || '').toLowerCase().split(';')[0].trim()) {
        case 'audio/wav':
        case 'audio/x-wav':
            return '.wav';
        case 'audio/mpeg':
        case 'audio/mp3':
            return '.mp3';
        case 'audio/ogg':
            return '.ogg';
        case 'audio/mp4':
        case 'audio/aac':
            return '.m4a';
        default:
            return '.webm';
    }
}
