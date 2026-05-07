"""All user-facing strings — single source of truth for i18n."""

APP_NAME       = "CortexAI"
APP_TAGLINE    = "Powered by Claude"
APP_VERSION    = "1.0"

# ── Sidebar ───────────────────────────────────────────────────────────────────
SIDEBAR_RECENTS         = "RECENTS"
SIDEBAR_NEW_CHAT        = "+ New Chat"
NAV_CHAT                = "Chat"
NAV_ANALYTICS           = "Analytics"
NAV_DOCS                = "Docs"
NAV_PLUGINS             = "Plugins"
NAV_SETTINGS            = "Settings"
STATUS_CONNECTED        = "Connected"
STATUS_DISCONNECTED     = "No key set"
STATUS_ERROR            = "Auth error"

# ── Chat empty state ──────────────────────────────────────────────────────────
GREETING_MORNING        = "Good morning"
GREETING_AFTERNOON      = "Good afternoon"
GREETING_EVENING        = "Good evening"
GREETING_SUBTITLE       = "What can I help you with today?"
CHIP_EMAIL              = "Draft an email"
CHIP_RESEARCH           = "Research a topic"
CHIP_CODE               = "Write code"
CHIP_ANALYZE            = "Analyse data"

CHIP_PROMPTS = {
    CHIP_EMAIL:    "Help me draft a professional email about ",
    CHIP_RESEARCH: "Research and summarize the key points about ",
    CHIP_CODE:     "Write Python code that ",
    CHIP_ANALYZE:  "Analyze this data and provide insights: ",
}

# ── Input bar ─────────────────────────────────────────────────────────────────
INPUT_PLACEHOLDER       = "Message CortexAI…  (Shift+Enter for new line)"
SEND_TOOLTIP            = "Send message (Enter)"
STOP_TOOLTIP            = "Stop generation (Escape)"
ATTACH_TOOLTIP          = "Attach file"
TOKEN_COUNT_FMT         = "{count} / 200k"

# ── Message actions ───────────────────────────────────────────────────────────
ACTION_COPY             = "Copy"
ACTION_REGENERATE       = "Regenerate"
ACTION_THUMBS_UP        = "Good response"
ACTION_THUMBS_DOWN      = "Bad response"
COPIED_TOAST            = "Copied to clipboard"

# ── Model switcher ────────────────────────────────────────────────────────────
MODEL_SWITCHER_TITLE    = "Choose a model"
MODEL_BADGE_RECOMMENDED = "RECOMMENDED"
MODEL_AUTO_LABEL        = "Smart Routing (Auto)"
MODEL_AUTO_DESC         = "Selects the best model per request automatically."

MODELS = [
    {
        "provider":    "auto",
        "id":          "auto",
        "label":       MODEL_AUTO_LABEL,
        "description": MODEL_AUTO_DESC,
        "recommended": False,
    },
    {
        "provider":    "anthropic",
        "id":          "claude-opus-4-5",
        "label":       "claude-opus-4",
        "description": "Most capable. Best for complex tasks.",
        "recommended": True,
    },
    {
        "provider":    "anthropic",
        "id":          "claude-sonnet-4-20250514",
        "label":       "claude-sonnet-4",
        "description": "Balanced speed and intelligence.",
        "recommended": False,
    },
    {
        "provider":    "anthropic",
        "id":          "claude-haiku-4-5-20251001",
        "label":       "claude-haiku-4",
        "description": "Fastest. Best for simple tasks.",
        "recommended": False,
    },
    {
        "provider":    "openai",
        "id":          "gpt-4o",
        "label":       "gpt-4o",
        "description": "Strong all-rounder.",
        "recommended": False,
    },
    {
        "provider":    "openai",
        "id":          "gpt-4o-mini",
        "label":       "gpt-4o-mini",
        "description": "Fast and affordable.",
        "recommended": False,
    },
]

DEFAULT_MODEL_ID = "claude-sonnet-4-20250514"

# ── Conversation history ──────────────────────────────────────────────────────
CONV_RENAME     = "Rename"
CONV_DELETE     = "Delete"
CONV_DELETE_MSG = "Delete this conversation? This cannot be undone."
CONV_UNTITLED   = "Untitled conversation"

# ── Settings ──────────────────────────────────────────────────────────────────
SETTINGS_API_KEYS        = "API Keys"
SETTINGS_MODELS          = "Models & Performance"
SETTINGS_FEATURES        = "Features"
SETTINGS_APPEARANCE      = "Appearance"
SETTINGS_DATA            = "Data & Privacy"
SETTINGS_ABOUT           = "About"
SETTINGS_TEST_CONNECTION = "Test"
SETTINGS_SAVE            = "Save"
SETTINGS_CLEAR_ALL       = "Clear All Conversations"
SETTINGS_EXPORT_JSON     = "Export JSON"
SETTINGS_EXPORT_CSV      = "Export CSV"
API_KEY_PLACEHOLDER_ANT  = "sk-ant-…"
API_KEY_PLACEHOLDER_OAI  = "sk-…"
API_KEY_SAVED_TOAST      = "API key saved"
API_KEY_INVALID_TOAST    = "API key is invalid"

# ── System / errors ───────────────────────────────────────────────────────────
NO_API_KEY_HEADING  = "Welcome to CortexAI"
NO_API_KEY_BODY     = "Add your Anthropic API key to get started."
NO_API_KEY_BTN      = "Go to Settings"
ERROR_RATE_LIMIT    = "Rate limit reached — please wait a moment."
ERROR_NETWORK       = "No internet connection."
ERROR_AUTH          = "Invalid API key — check Settings."
ERROR_GENERIC       = "Something went wrong. Please try again."
ERROR_RETRY         = "Retry"
RESPONSE_INTERRUPTED = "Response interrupted"
RESPONSE_CONTINUE    = "Continue"
NOTHING_TO_EXPORT    = "Nothing to export"
EXPORT_SAVED_FMT     = "Saved to {path}"

# ── Shortcuts popover ─────────────────────────────────────────────────────────
SHORTCUTS_TITLE = "Keyboard Shortcuts"
SHORTCUT_DEFS = [
    ("Ctrl+N",       "New conversation"),
    ("Ctrl+K",       "Open model switcher"),
    ("Ctrl+/",       "Show all shortcuts"),
    ("Ctrl+,",       "Open settings"),
    ("Ctrl+L",       "Clear conversation"),
    ("Ctrl+E",       "Export conversation"),
    ("Ctrl+F",       "Search in conversation"),
    ("Ctrl+1–5",     "Switch tabs"),
    ("Ctrl+Shift+C", "Copy last response"),
    ("Escape",       "Stop / close popover"),
    ("Enter",        "Send message"),
    ("Shift+Enter",  "New line"),
]
