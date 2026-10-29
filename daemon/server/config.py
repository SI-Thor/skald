"""skald daemon configuration (env-overridable)."""
import os

RIVA_HTTP_URI = os.environ.get("RIVA_HTTP_URI", "http://localhost:50000")
RIVA_GRPC_URI = os.environ.get("RIVA_GRPC_URI", "localhost:50051")
PORT = int(os.environ.get("SKALD_DAEMON_PORT", "8000"))
VOICES_CACHE_SECONDS = int(os.environ.get("SKALD_VOICES_CACHE_S", "60"))
DEFAULT_VOICE = os.environ.get("SKALD_DEFAULT_VOICE", "Magpie-Multilingual.EN-US.Mia")
