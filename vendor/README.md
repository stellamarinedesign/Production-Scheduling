# vendor/ - libraries kept in this repository

Every Stella app and the hub share one web address, so a script loaded from
another site runs where it could read every app's saved sign-in on the device.
The board's libraries are kept here instead, byte for byte as published, each
in a folder named for its version and loaded without ?v=, so a board release
does not make a browser fetch them again. `.gitattributes` keeps git from
changing their line endings. Firebase still comes from Google (js/firebase.js).

To change a version: add a new folder beside the old one, check the copy as
below, point the adapter at it, then remove the old folder.

| Folder | From | sha256 | Licence | Used by |
|---|---|---|---|---|
| xlsx-0.20.3 | https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs | 1a0fb062ee9781b13f6687371b202aaefc53b6ce55b530c027e01f9c087b77db | Apache 2.0 (LICENSE) | js/adapters/xlsx.js (ERP and stock imports) |

Checked 27 Nov 2026: two downloads from cdn.sheetjs.com, byte-identical;
SheetJS publishes 0.20.3 nowhere else that can be read without signing in.
