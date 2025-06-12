import translationsContent from '../translations';

export const translations = translationsContent;

export const supportedLanguages = ['en', 'el'] as const;
export type SupportedLanguages = (typeof supportedLanguages)[number];
