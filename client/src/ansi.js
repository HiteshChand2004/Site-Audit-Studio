// Terminal colour codes in an error text (server errors from Playwright and the build tools) are not shown to a user.
export const stripAnsi = (text) => String(text ?? '').replace(/(\u001b|\uFFFD)?\[[0-9;]*m/g, '');
