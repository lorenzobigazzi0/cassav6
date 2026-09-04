import angryFeedbackSrc from "./angry.png";
import happyFeedbackSrc from "./happy.png";
import sadFeedbackSrc from "./sad.png";

export const automaticCashFeedbackAssets = {
  happy: happyFeedbackSrc,
  sad: sadFeedbackSrc,
  angry: angryFeedbackSrc,
} as const;

export type AutomaticCashFeedbackKind = keyof typeof automaticCashFeedbackAssets;
