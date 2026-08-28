"""Realistic-ish sample emails used to exercise the parser and the dashboard."""

PC_ORDER_HTML = """<html><body>
<table><tr><td><img src="logo.png"></td></tr></table>
<h1>Thanks for your order!</h1>
<p>Hi Roberto, we're getting your order ready.</p>
<table>
  <tr><td>Order Number</td><td>PC10488213</td></tr>
  <tr><td>Order Date</td><td>May 14, 2026</td></tr>
</table>
<table>
  <tr><th>Item</th><th>Qty</th><th>Price</th></tr>
  <tr><td>Pok&eacute;mon TCG: Prismatic Evolutions Elite Trainer Box</td><td>Qty: 2</td><td>$49.99</td></tr>
  <tr><td>Pikachu Plush &mdash; 8 inch</td><td>Qty: 1</td><td>$24.99</td></tr>
</table>
<table>
  <tr><td>Subtotal</td><td>$124.97</td></tr>
  <tr><td>Shipping</td><td>$0.00</td></tr>
  <tr><td>Estimated Tax</td><td>$10.31</td></tr>
  <tr><td>Order Total</td><td>$135.28</td></tr>
</table>
<p><a href="https://www.pokemoncenter.com/orders">View your order</a></p>
</body></html>"""

PC_PREORDER_HTML = """<html><body>
<h1>Your pre-order is confirmed</h1>
<p>We'll charge your card when your pre-order ships.</p>
<table><tr><td>Order Number</td><td>PC10502991</td></tr></table>
<table>
  <tr><td>Pok&eacute;mon TCG: Mega Evolution Elite Trainer Box</td><td>Qty: 3</td><td>$59.99</td></tr>
  <tr><td>Mega Charizard Figure</td><td>Qty: 1</td><td>$39.99</td></tr>
</table>
<table>
  <tr><td>Subtotal</td><td>$219.96</td></tr>
  <tr><td>Estimated Tax</td><td>$18.15</td></tr>
  <tr><td>Order Total</td><td>$238.11</td></tr>
</table>
</body></html>"""

PC_PREORDER2_HTML = """<html><body>
<h1>Your pre-order is confirmed</h1>
<table><tr><td>Order Number</td><td>PC10577310</td></tr></table>
<table>
  <tr><td>Pok&eacute;mon TCG: Destined Rivals Booster Bundle</td><td>Qty: 6</td><td>$26.99</td></tr>
</table>
<table>
  <tr><td>Subtotal</td><td>$161.94</td></tr>
  <tr><td>Estimated Tax</td><td>$13.36</td></tr>
  <tr><td>Order Total</td><td>$175.30</td></tr>
</table>
</body></html>"""

PC_SHIPPED_HTML = """<html><body>
<h1>Your order has shipped</h1>
<p>Order #PC10488213 is on its way.</p>
<p>Tracking number: 1Z999AA10123456784</p>
</body></html>"""

PC_CANCEL_HTML = """<html><body>
<h1>Your order has been canceled</h1>
<p>We're sorry &mdash; order number PC10499001 has been canceled and you have not been charged.</p>
</body></html>"""

PC_OLD_ORDER_HTML = """<html><body>
<h1>Thanks for your order!</h1>
<table><tr><td>Order Number</td><td>PC10201776</td></tr></table>
<table>
  <tr><td>Pok&eacute;mon TCG: Surging Sparks Booster Box</td><td>Qty: 1</td><td>$161.64</td></tr>
</table>
<table><tr><td>Order Total</td><td>$174.57</td></tr></table>
</body></html>"""

TARGET_ORDER_HTML = """<html><body>
<h1>Thanks for your order</h1>
<p>Order # 3021445907621</p>
<table>
  <tr><td>Pokemon Trading Card Game: Mega Evolution Elite Trainer Box</td><td>Qty: 2</td><td>$49.99</td></tr>
</table>
<table>
  <tr><td>Subtotal</td><td>$99.98</td></tr>
  <tr><td>Order Total</td><td>$108.73</td></tr>
</table>
</body></html>"""

TARGET_TOWELS_HTML = """<html><body>
<h1>Thanks for your order</h1>
<p>Order # 3021999000111</p>
<table><tr><td>Threshold Bath Towel Set</td><td>Qty: 1</td><td>$29.99</td></tr></table>
<table><tr><td>Order Total</td><td>$32.61</td></tr></table>
</body></html>"""

NEWSLETTER_HTML = """<html><body>
<h1>New arrivals at Pok&eacute;mon Center</h1>
<p>Shop the latest plush and figures. Free shipping over $20.</p>
</body></html>"""

# (subject, from_addr, from_name, received_at, html)
SAMPLES = [
    ("Thanks for your order!", "orders@pokemoncenter.com", "Pokemon Center",
     "2026-02-11T15:04:00+00:00", PC_OLD_ORDER_HTML),
    ("Thanks for your order!", "orders@pokemoncenter.com", "Pokemon Center",
     "2026-05-14T18:22:00+00:00", PC_ORDER_HTML),
    ("Your order has shipped", "shipping@pokemoncenter.com", "Pokemon Center",
     "2026-05-17T11:02:00+00:00", PC_SHIPPED_HTML),
    ("Your pre-order is confirmed", "orders@pokemoncenter.com", "Pokemon Center",
     "2026-06-02T09:31:00+00:00", PC_PREORDER_HTML),
    ("Your pre-order is confirmed", "orders@pokemoncenter.com", "Pokemon Center",
     "2026-07-19T20:15:00+00:00", PC_PREORDER2_HTML),
    ("Your order has been canceled", "orders@pokemoncenter.com", "Pokemon Center",
     "2026-06-20T08:00:00+00:00", PC_CANCEL_HTML),
    ("Thanks for your order", "orders@oes.target.com", "Target",
     "2026-07-01T16:45:00+00:00", TARGET_ORDER_HTML),
    ("Thanks for your order", "orders@oes.target.com", "Target",
     "2026-07-03T10:00:00+00:00", TARGET_TOWELS_HTML),
    ("New arrivals at Pokemon Center", "news@pokemoncenter.com", "Pokemon Center",
     "2026-08-01T12:00:00+00:00", NEWSLETTER_HTML),
]

RELEASES = [
    ("Mega Evolution Elite Trainer Box", "2026-09-26", "mega evolution", 59.99, ""),
    ("Destined Rivals Booster Bundle", "2026-10-17", "destined rivals", 26.99, "Pokemon Center"),
    ("Mega Charizard Figure", "2026-09-26", "mega charizard", 39.99, ""),
]
