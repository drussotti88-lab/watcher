$u = 'https://i5.walmartimages.com/seo/Pokemon-TCG-Mega-Evolution-Pitch-Black-Booster-Bundle_88f33160-98a1-4a49-b282-d1cfabaf55c7.1842934570f25895671b96db9d24e832.jpeg?odnHeight=640&odnWidth=640&odnBg=FFFFFF'
$out = 'C:\Users\danru\Pokemon\product.jpg'
Invoke-WebRequest -Uri $u -OutFile $out -UseBasicParsing
$f = Get-Item $out
Write-Output ("bytes {0}" -f $f.Length)
