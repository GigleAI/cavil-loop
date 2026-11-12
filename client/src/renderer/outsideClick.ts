// The mark of an element whose click opens an item. The detail used to float over the board and a
// click outside it put it away, except on such an element (GitHub#191); since GitHub#397 the detail
// is a tab of its own, and what is left of that rule is this mark: the middle button on a marked
// element opens the item's tab in the background (App.tsx).

/** Marks an element whose click opens an item (a card, a table row's title, a graph box). */
export const OPENS_ITEM = 'data-opens-item';
