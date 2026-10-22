export const currency = (value: unknown) => `£${Number(value ?? 0).toLocaleString('en-GB')}`;
