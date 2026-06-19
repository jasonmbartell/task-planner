import { nanoid } from 'nanoid';

export const genId = (prefix) => `${prefix}-${nanoid(8)}`;
