"""Training a voice (docs/local-voice.md "Training a voice"): a LoRA adapter for a speech model (OmniVoice, Qwen3-TTS,
CosyVoice3) from the recordings of one person, made in its own process in that model's runtime
(python -m app.voicehost.train <run dir>); what is the model's own is its recipe (recipe.py → omni.py, qwen.py,
cosy.py).

The server (app/voicehost/training.py) writes the run's ``job.json``, starts the process and reads its progress: one
``@@train {json}`` line per event on stdout. It sends ``pause`` / ``resume`` / ``stop`` lines on stdin (a mate speaking
or a call: the GPU is theirs first). The stages:

    prepare     the recordings cut into utterances at their pauses (segment.py)
    transcribe  each utterance's words, by Whisper (the voice host's own weights)
    screen      only her: utterances of another speaker (CAM++ speaker embeddings), or with doubtful words, or too
                loud / quiet, are left out
    tokens      the utterances in the model's own terms (its audio tokens, codes, mel …)
    baseline    the zero-shot clone measured: speaker similarity and intelligibility, with a long reference, a short
                one and none
    train       LoRA on the model's own layers, on its own loss (bf16, gradient checkpointing), measured the same
                way along the way
    done        the best checkpoint (the most like her, never less intelligible) as an adapter, with A/B samples
"""

PREFIX = "@@train "

# the stages, in order (the UI's steps)
STAGES = ("prepare", "transcribe", "screen", "tokens", "baseline", "train", "done")
