/** O servidor troca o link de quem não o enviou por um id opaco (`lk_…`); ele é aceito onde o link iria (`?url=`). */
export const isLinkId = (value: unknown): value is string => typeof value === 'string' && /^lk_[A-Za-z0-9_-]{22}$/.test(value);

/** Um endereço http(s) ou o id opaco de um: vem de fora do site e passa pelo proxy. */
export const isRemoteSource = (value: string): boolean => /^https?:\/\//i.test(value) || isLinkId(value);
