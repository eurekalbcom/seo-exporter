import { isAutocompleteEnabled, isBingEnabled } from "@/lib/flags";

export type OptionalWorkerState = {
  bing: boolean;
  autocomplete: boolean;
};

/** Whether the operator turned the optional providers on. Default is both off. */
export function optionalProvidersEnabled(): OptionalWorkerState {
  return {
    bing: isBingEnabled(),
    autocomplete: isAutocompleteEnabled(),
  };
}

/**
 * Background loops are not started. Bing and autocomplete stay request-driven,
 * and their routes answer 404 while the matching flag is off.
 */
export function startOptionalWorkers(): OptionalWorkerState {
  return { bing: false, autocomplete: false };
}
