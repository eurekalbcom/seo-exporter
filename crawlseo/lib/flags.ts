function enabled(name: string): boolean {
  return process.env[name]?.trim().toLowerCase() === "true";
}

/** Default off. Bing routes 404 and the Bing sync worker does not run. */
export function isBingEnabled(): boolean {
  return enabled("BING_ENABLED");
}

/** Default off. Autocomplete routes 404 and no autocomplete fetch runs. */
export function isAutocompleteEnabled(): boolean {
  return enabled("AUTOCOMPLETE_ENABLED");
}
