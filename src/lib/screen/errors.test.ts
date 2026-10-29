import { describe, expect, it } from 'vitest';
import { isPickerCancel } from './errors';

const err = (name: string, message = '') => Object.assign(new Error(message), { name });

describe('isPickerCancel', () => {
  it('the user closing the picker is a cancel', () => {
    expect(isPickerCancel(err('NotAllowedError', 'Permission denied'))).toBe(true);
    expect(isPickerCancel(err('AbortError', 'Aborted'))).toBe(true);
  });

  it('a block by the operating system or a policy is a real failure, not a cancel', () => {
    expect(isPickerCancel(err('NotAllowedError', 'Permission denied by system'))).toBe(false);
    expect(isPickerCancel(err('NotAllowedError', 'Disallowed by permissions policy'))).toBe(false);
  });

  it('anything else is not a cancel', () => {
    expect(isPickerCancel(err('NotFoundError'))).toBe(false);
    expect(isPickerCancel(new Error('x'))).toBe(false);
    expect(isPickerCancel(null)).toBe(false);
    expect(isPickerCancel('NotAllowedError')).toBe(false);
  });
});
