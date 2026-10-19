// Terminal colour codes (from Playwright and the build tools) that end up in error messages: removed before an error is kept
// or shown, so a user never reads "[2m" in the text.
export const stripAnsi = (text) => String(text ?? '').replace(/(\u001b|\uFFFD)?\[[0-9;]*m/g, '');
