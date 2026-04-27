export const safeId = (input: string): string =>
    input
        .toLowerCase()
        .replace(/[^a-z\s]/g, '')
        .trim()
        .replace(/\s+/g, '.')
