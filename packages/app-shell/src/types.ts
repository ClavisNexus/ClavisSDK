/** The preparation phases, in the order the overlay shows them. Order is part of the public UX contract. */
export const HANDOFF_PHASE_IDS = ["digest", "register"] as const;

export type HandoffPhaseId = (typeof HANDOFF_PHASE_IDS)[number];

/** Every end-user string the overlay shows. Keys are shared across languages; each language has its own wording. */
export type HandoffText = {
  /** Head of the overlay while the handoff runs. */
  title: string;
  hint: string;
  /** Heading above the progress log in `stream` mode. */
  streamTitle: string;
  /** One label per phase id. The order on screen comes from `HANDOFF_PHASE_IDS`. */
  phases: Record<HandoffPhaseId, string>;
  /** Head of the overlay after a failure. */
  errorTitle: string;
  errorHint: string;
  /** Shown when another attempt may get through (the `register` step failed). */
  errorRetry: string;
  /** Shown when another attempt will not help. */
  errorBlocked: string;
};

/** Wording to put over the resolved language, key by key. */
export type HandoffTextOverride = Partial<Omit<HandoffText, "phases">> & {
  phases?: Partial<Record<HandoffPhaseId, string>>;
};

export type HandoffShellMode = "quiet" | "stream";

export type HandoffRegisterContext = {
  appendLines: (lines: string[]) => void;
};

export type OpenHandoffShellOptions = {
  /** Default is quiet. stream appends a progress log through appendLines. */
  mode?: HandoffShellMode;
  title?: string;
  hint?: string;
  /**
   * BCP 47 language tags for the overlay, in order of preference.
   * Omitting it follows the browser's languages, then `en`.
   */
  uiLocales?: readonly string[];
  /**
   * Wording for the keys the bundled languages cover, and for a language they do not.
   * `title` and `hint` above still win over this.
   */
  text?: HandoffTextOverride;
  /** Mount node; default document.body */
  parent?: HTMLElement;
  /**
   * Call the app BFF. The shell owns phase order and the gap between phases.
   */
  register: (ctx: HandoffRegisterContext) => Promise<void>;
  /**
   * Milliseconds between phase advances. Reduced motion forces 0.
   * Values above 420 are capped.
   */
  phaseGapMs?: number;
};
