# SkyFlip

Live Hypixel SkyBlock auction house flip finder. Open the site: **https://zacktihi.github.io/skyflip/**

Everything runs in your browser on Hypixel's public auction API. No server, no API key.

- Every minute it fetches all auction pages, decodes each item's real SkyBlock ID, and groups listings by item plus stars, recombobulator, skin, attributes, and pet level/held item.
- The buy is the cheapest BIN. The sell price is the lower of the next-cheapest listing from another seller and the median of recent real sales.
- Profit is after the listing fee (1% under 10M, 2% to 100M, 2.5% above) and the 1% claim tax above 1M, which is 4x while Derpy is mayor (detected automatically).
- **S** check: recent sales back up the sell price. Sales are recorded in your browser while the page is open, so this fills in over time.
- **D** check: another seller lists within 10% of the sell price, so one overpriced listing can't fake a profit.

Hypixel only rebuilds its auction list about once a minute, so this finds flips that last a minute or more, not instant snipes. Enchantments and reforges on gear aren't part of the grouping and are flagged on each row; check the item in game before buying.
