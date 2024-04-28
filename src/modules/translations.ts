import translationsContent from '../translations.ts';

export const translations = translationsContent;

export const supportedLanguages = ['en', 'el'] as const;
export type SupportedLanguages = (typeof supportedLanguages)[number];
