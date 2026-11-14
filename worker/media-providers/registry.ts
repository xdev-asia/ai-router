/**
 * The media-only providers (TTS, STT, image and embedding providers that are not chat providers). They
 * keep their keys in `connection` like the chat providers, but are not in PROVIDERS: they are not chat or combo
 * targets, and /v1/models does not list them. `model` on a media path is `<id or alias>/<model>`.
 */
import { voyageEmbeddings, jinaEmbeddings, type EmbeddingsAdapter } from "./embeddings";
import { bflImages, falImages, huggingfaceImages, minimaxImages, recraftImages, runwayImages, stabilityImages, type ImageAdapter } from "./images";
import { awsKeyParts, cartesiaSpeech, elevenlabsSpeech, fishSpeech, inworldSpeech, minimaxSpeech, playhtSpeech, pollySpeech, type SpeechAdapter } from "./speech";
import { assemblyaiTranscription, deepgramTranscription, elevenlabsTranscription, huggingfaceTranscription, type TranscriptionAdapter } from "./transcription";

export type MediaKindName = "embeddings" | "images" | "speech" | "transcription";

/** How the key is written: `plain`, `aws` (ACCESS_KEY_ID:SECRET[:REGION]) or `playht` (USER_ID:API_KEY). */
export type KeyFormat = "plain" | "aws" | "playht";

interface Entry<A> {
  models: readonly string[];
  run: A;
}

export interface MediaProvider {
  id: string;
  name: string;
  color: string;
  mark: string;
  keyUrl: string;
  alias?: string;
  keyFormat: KeyFormat;
  kinds: {
    speech?: Entry<SpeechAdapter>;
    transcription?: Entry<TranscriptionAdapter>;
    images?: Entry<ImageAdapter>;
    embeddings?: Entry<EmbeddingsAdapter>;
  };
}

const MINIMAX_SPEECH = ["speech-2.8-hd", "speech-2.8-turbo", "speech-2.6-hd", "speech-2.6-turbo", "speech-02-hd", "speech-02-turbo", "speech-01-hd", "speech-01-turbo"];
const MINIMAX_KEYS = "https://platform.minimaxi.com/user-center/basic-information/interface-key";

export const MEDIA_PROVIDERS: readonly MediaProvider[] = [
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    color: "#6C47FF",
    mark: "EL",
    alias: "el",
    keyUrl: "https://elevenlabs.io/app/settings/api-keys",
    keyFormat: "plain",
    kinds: {
      speech: { models: ["eleven_multilingual_v2", "eleven_turbo_v2_5", "eleven_flash_v2_5"], run: elevenlabsSpeech },
      transcription: { models: ["scribe_v1", "scribe_v2"], run: elevenlabsTranscription },
    },
  },
  {
    id: "deepgram",
    name: "Deepgram",
    color: "#13EF93",
    mark: "DG",
    alias: "dg",
    keyUrl: "https://console.deepgram.com/api-keys",
    keyFormat: "plain",
    kinds: { transcription: { models: ["nova-3", "nova-2", "nova", "whisper-large"], run: deepgramTranscription } },
  },
  {
    id: "assemblyai",
    name: "AssemblyAI",
    color: "#0062FF",
    mark: "AA",
    alias: "aai",
    keyUrl: "https://www.assemblyai.com/app/api-keys",
    keyFormat: "plain",
    kinds: { transcription: { models: ["universal-3-pro", "universal-2", "best", "nano"], run: assemblyaiTranscription } },
  },
  {
    id: "black-forest-labs",
    name: "Black Forest Labs",
    color: "#111827",
    mark: "BF",
    alias: "bfl",
    keyUrl: "https://api.bfl.ai",
    keyFormat: "plain",
    kinds: { images: { models: ["flux-pro-1.1", "flux-pro-1.1-ultra", "flux-pro", "flux-dev", "flux-kontext-pro", "flux-kontext-max"], run: bflImages } },
  },
  {
    id: "fal-ai",
    name: "fal",
    color: "#2563EB",
    mark: "FL",
    alias: "fal",
    keyUrl: "https://fal.ai/dashboard/keys",
    keyFormat: "plain",
    kinds: {
      images: {
        models: ["fal-ai/flux/schnell", "fal-ai/flux/dev", "fal-ai/flux-pro/v1.1", "fal-ai/flux-pro/v1.1-ultra", "fal-ai/recraft-v3", "fal-ai/ideogram/v2", "fal-ai/stable-diffusion-v35-large"],
        run: falImages,
      },
    },
  },
  {
    id: "stability-ai",
    name: "Stability AI",
    color: "#8B5CF6",
    mark: "SA",
    alias: "stability",
    keyUrl: "https://platform.stability.ai/account/keys",
    keyFormat: "plain",
    kinds: { images: { models: ["stable-image-ultra", "stable-image-core", "sd3.5-large", "sd3.5-large-turbo", "sd3.5-medium"], run: stabilityImages } },
  },
  {
    id: "recraft",
    name: "Recraft",
    color: "#EC4899",
    mark: "RC",
    keyUrl: "https://www.recraft.ai/profile/api",
    keyFormat: "plain",
    kinds: { images: { models: ["recraftv3", "recraftv2"], run: recraftImages } },
  },
  {
    id: "runwayml",
    name: "Runway",
    color: "#000000",
    mark: "RW",
    alias: "runway",
    keyUrl: "https://dev.runwayml.com",
    keyFormat: "plain",
    kinds: { images: { models: ["gen4_image", "gen4_image_turbo"], run: runwayImages } },
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    color: "#FFD21E",
    mark: "HF",
    alias: "hf",
    keyUrl: "https://huggingface.co/settings/tokens",
    keyFormat: "plain",
    kinds: {
      images: {
        models: ["black-forest-labs/FLUX.1-schnell", "black-forest-labs/FLUX.1-dev", "stabilityai/stable-diffusion-xl-base-1.0", "stabilityai/stable-diffusion-3.5-large", "Qwen/Qwen-Image"],
        run: huggingfaceImages,
      },
      transcription: { models: ["openai/whisper-large-v3", "openai/whisper-large-v3-turbo"], run: huggingfaceTranscription },
    },
  },
  {
    id: "minimax",
    name: "MiniMax",
    color: "#7C3AED",
    mark: "MM",
    keyUrl: MINIMAX_KEYS,
    keyFormat: "plain",
    kinds: {
      speech: { models: MINIMAX_SPEECH, run: minimaxSpeech("api.minimax.io") },
      images: { models: ["image-01"], run: minimaxImages("api.minimax.io") },
    },
  },
  {
    id: "minimax-cn",
    name: "MiniMax (China)",
    color: "#DC2626",
    mark: "MC",
    keyUrl: MINIMAX_KEYS,
    keyFormat: "plain",
    kinds: {
      speech: { models: MINIMAX_SPEECH, run: minimaxSpeech("api.minimaxi.com") },
      images: { models: ["image-01"], run: minimaxImages("api.minimaxi.com") },
    },
  },
  {
    id: "cartesia",
    name: "Cartesia",
    color: "#FF4F8B",
    mark: "CA",
    keyUrl: "https://play.cartesia.ai/keys",
    keyFormat: "plain",
    kinds: { speech: { models: ["sonic-2", "sonic-3"], run: cartesiaSpeech } },
  },
  {
    id: "fish-audio",
    name: "Fish Audio",
    color: "#1E9BF0",
    mark: "FA",
    alias: "fish",
    keyUrl: "https://fish.audio/app/api-keys/",
    keyFormat: "plain",
    kinds: { speech: { models: ["s2.1-pro-free", "s2.1-pro", "s2-pro", "s1"], run: fishSpeech } },
  },
  {
    id: "playht",
    name: "PlayHT",
    color: "#00B4D8",
    mark: "PH",
    keyUrl: "https://play.ht/studio/api-access",
    keyFormat: "playht",
    kinds: { speech: { models: ["PlayDialog", "Play3.0-mini"], run: playhtSpeech } },
  },
  {
    id: "inworld",
    name: "Inworld",
    color: "#FF6B6B",
    mark: "IW",
    keyUrl: "https://platform.inworld.ai/api-keys",
    keyFormat: "plain",
    kinds: { speech: { models: ["inworld-tts-1.5-mini", "inworld-tts-1.5-max"], run: inworldSpeech } },
  },
  {
    id: "aws-polly",
    name: "Amazon Polly",
    color: "#FF9900",
    mark: "PL",
    alias: "polly",
    keyUrl: "https://console.aws.amazon.com/iam/home#/security_credentials",
    keyFormat: "aws",
    kinds: { speech: { models: ["standard", "neural", "long-form", "generative"], run: pollySpeech } },
  },
  {
    id: "voyage-ai",
    name: "Voyage AI",
    color: "#0EA5E9",
    mark: "VG",
    alias: "voyage",
    keyUrl: "https://dash.voyageai.com/api-keys",
    keyFormat: "plain",
    kinds: {
      embeddings: { models: ["voyage-3-large", "voyage-3.5", "voyage-3.5-lite", "voyage-code-3", "voyage-finance-2", "voyage-law-2", "voyage-multilingual-2"], run: voyageEmbeddings },
    },
  },
  {
    id: "jina-ai",
    name: "Jina AI",
    color: "#2563EB",
    mark: "JA",
    alias: "jina",
    keyUrl: "https://jina.ai/?sui=apikey",
    keyFormat: "plain",
    kinds: { embeddings: { models: ["jina-embeddings-v3", "jina-embeddings-v2-base-en", "jina-embeddings-v2-base-code"], run: jinaEmbeddings } },
  },
];

/**
 * Known media providers left out, with why (the console shows the reason by its code):
 * `scrapes`: it calls an undocumented web endpoint with a browser's identity and anti-bot tokens;
 * `no_api`: no text-to-image API to adapt; `local`: it runs on the user's machine, which a Worker cannot reach;
 * `custom`: an OpenAI-compatible server, added as a custom provider; `no_auth`: a server with no authentication,
 * which a Worker can only reach when it is open to the internet; `placeholder`: no adapter exists for it in the open-source gateway these entries come from either.
 */
export const UNSUPPORTED_MEDIA: readonly { id: string; name: string; reason: "scrapes" | "no_api" | "local" | "custom" | "no_auth" | "placeholder" }[] = [
  { id: "google-tts", name: "Google Translate TTS", reason: "scrapes" },
  { id: "edge-tts", name: "Edge TTS", reason: "scrapes" },
  { id: "topaz", name: "Topaz", reason: "no_api" },
  { id: "local-device", name: "Local device", reason: "local" },
  { id: "selfhosted-embedding", name: "Self-hosted embeddings", reason: "custom" },
  { id: "selfhosted-stt", name: "Self-hosted speech to text", reason: "custom" },
  { id: "selfhosted-tts", name: "Self-hosted text to speech", reason: "custom" },
  { id: "sdwebui", name: "SD WebUI", reason: "no_auth" },
  { id: "coqui", name: "Coqui TTS", reason: "no_auth" },
  { id: "tortoise", name: "Tortoise TTS", reason: "no_auth" },
  { id: "comfyui", name: "ComfyUI", reason: "placeholder" },
];

const BY_ID = new Map(MEDIA_PROVIDERS.map((p) => [p.id, p]));
const BY_ALIAS = new Map(MEDIA_PROVIDERS.filter((p) => p.alias).map((p) => [p.alias!, p]));

export const mediaProvider = (id: string): MediaProvider | null => BY_ID.get(id) ?? null;

/** The media provider a model prefix names: its id, or its alias. The caller checks a chat prefix comes first. */
export const mediaProviderOfPrefix = (prefix: string): { provider: MediaProvider; byAlias: boolean } | null => {
  const p = BY_ID.get(prefix);
  if (p) return { provider: p, byAlias: false };
  const a = BY_ALIAS.get(prefix);
  return a ? { provider: a, byAlias: true } : null;
};

export const kindsOf = (p: MediaProvider): MediaKindName[] => (["embeddings", "images", "speech", "transcription"] as const).filter((k) => p.kinds[k]);

/** Why `key` cannot be this provider's key, or null when it can. */
export function keyFormatError(p: MediaProvider, key: string): string | null {
  if (p.keyFormat === "aws") return awsKeyParts(key) ? null : "api_key: ACCESS_KEY_ID:SECRET_ACCESS_KEY, optionally :REGION";
  if (p.keyFormat === "playht") return /^[^:\s]+:[^:\s]+$/.test(key) ? null : "api_key: USER_ID:API_KEY";
  return /\s/.test(key) ? "api_key: no spaces" : null;
}
