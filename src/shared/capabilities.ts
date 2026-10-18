import type { Platform } from "./types.js";

/**
 * What each inbox platform renders natively through Zernio's send endpoint,
 * per Zernio's platform docs (October 2026). Anything not supported is
 * degraded to text by `buildSendBodies` instead of being rejected.
 */
export type PlatformCapabilities = {
  /** Max reply buttons in one message (0 = none). */
  replyButtons: number;
  /** Max options for a choice list (WhatsApp list rows, Meta quick replies). */
  listOptions: number;
  /** Native list with sections and row descriptions. */
  sectionedList: boolean;
  /** Button that opens a URL. */
  urlButton: boolean;
  locationRequest: boolean;
  locationPin: boolean;
  carousel: boolean;
  /** Approved message templates (out-of-window sends). */
  templates: boolean;
  contacts: boolean;
  /** Media attachments by URL. */
  attachments: boolean;
  /** Text and an attachment in the same send. */
  captionWithMedia: boolean;
  reactions: boolean;
  typing: boolean;
  /** Text limit when reply/URL buttons are attached (Meta button template). */
  buttonTextMax?: number;
};

const TEXT_ONLY: PlatformCapabilities = {
  replyButtons: 0,
  listOptions: 0,
  sectionedList: false,
  urlButton: false,
  locationRequest: false,
  locationPin: false,
  carousel: false,
  templates: false,
  contacts: false,
  attachments: false,
  captionWithMedia: false,
  reactions: false,
  typing: false,
};

const META: PlatformCapabilities = {
  ...TEXT_ONLY,
  replyButtons: 3,
  listOptions: 13,
  urlButton: true,
  carousel: true,
  attachments: true,
  captionWithMedia: true,
  reactions: true,
  buttonTextMax: 640,
};

export const PLATFORM_CAPABILITIES: Record<Platform, PlatformCapabilities> = {
  whatsapp: {
    replyButtons: 3,
    listOptions: 10,
    sectionedList: true,
    urlButton: true,
    locationRequest: true,
    locationPin: true,
    carousel: false,
    templates: true,
    contacts: true,
    attachments: true,
    captionWithMedia: true,
    reactions: true,
    typing: true,
  },
  facebook: META,
  instagram: META,
  telegram: {
    ...TEXT_ONLY,
    replyButtons: 100,
    listOptions: 100,
    urlButton: true,
    attachments: true,
    captionWithMedia: true,
  },
  imessage: {
    ...TEXT_ONLY,
    locationPin: true,
    attachments: true,
    captionWithMedia: true,
    reactions: true,
    typing: true,
  },
  tiktok: { ...TEXT_ONLY, attachments: true, captionWithMedia: false },
  sms: TEXT_ONLY,
  rcs: TEXT_ONLY,
  twitter: TEXT_ONLY,
  bluesky: TEXT_ONLY,
  reddit: TEXT_ONLY,
  slack: TEXT_ONLY,
};

/** Capabilities of a platform name coming from a webhook (unknown → text only). */
export function capabilitiesOf(platform: string): PlatformCapabilities {
  return (PLATFORM_CAPABILITIES as Record<string, PlatformCapabilities>)[platform] ?? TEXT_ONLY;
}

export function isPlatform(value: string): value is Platform {
  return value in PLATFORM_CAPABILITIES;
}
