export type PuterChatResponse =
  | string
  | {
      message?: { content?: string; text?: string } | string;
      text?: string;
    };

declare global {
  interface Window {
    puter?: {
      ai: {
        chat: (
          prompt: string | string[],
          options?: Record<string, unknown>
        ) => Promise<PuterChatResponse>;
      };
      print?: (message: string) => void;
    };
  }
}

export {};
