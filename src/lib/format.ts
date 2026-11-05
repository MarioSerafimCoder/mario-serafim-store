const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const date = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long', timeZone: 'UTC' });

export const formatPrice = (cents: number) => brl.format(cents / 100);
export const formatDate = (iso: string) => date.format(new Date(iso));
