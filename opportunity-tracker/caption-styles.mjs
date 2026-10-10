export const SOCIAL_CAPTION_STYLES=['snapchat','instagram'];
export const isSocialCaptionStyle=value=>SOCIAL_CAPTION_STYLES.includes(value);
export const normalizeCaptionStyle=value=>isSocialCaptionStyle(value)?value:'instagram';
