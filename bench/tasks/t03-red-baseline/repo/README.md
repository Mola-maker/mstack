# price

`formatPrice(cents)` turns an integer number of cents into a string with two decimals and a leading `$`:
`formatPrice(1999)` is `"$19.99"`, `formatPrice(5)` is `"$0.05"`, `formatPrice(0)` is `"$0.00"`.
A negative amount is `"-$3.50"`. A non-integer throws `TypeError`.

## Known failures

`test/legacy.test.mjs` (legacy currency rounding) has failed since before this repo was split out. It is tracked
elsewhere and is not part of this work. Do not change it.
