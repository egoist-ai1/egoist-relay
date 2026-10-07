import sys
import os

def transcribe_audio_file(audio_path: str) -> str:
    if not os.path.exists(audio_path):
        return ""
    try:
        from faster_whisper import WhisperModel
        cpu_threads = min(12, os.cpu_count() or 4)
        model = WhisperModel("base", device="cpu", compute_type="int8", cpu_threads=cpu_threads)
        segments, _ = model.transcribe(
            audio_path,
            beam_size=2,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=400),
            initial_prompt="Разговорная русская речь, Telegram голосовое сообщение, IT, сервер, рабочий стол.",
            condition_on_previous_text=False,
        )
        text = " ".join(seg.text.strip() for seg in segments if seg.text.strip())
        return text.strip()
    except Exception as e:
        sys.stderr.write(f"Transcription error: {e}\n")
        return ""

def main():
    if len(sys.argv) < 2:
        sys.exit(0)

    audio_path = sys.argv[1]
    text = transcribe_audio_file(audio_path)
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    print(text)

if __name__ == '__main__':
    main()
