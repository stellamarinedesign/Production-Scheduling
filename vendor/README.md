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
| exceljs-4.4.0 | npm exceljs 4.4.0, dist/exceljs.min.js | 7e49da68588e250dbb8bba190d2caa8ab3787cc0284bda1d8b2f805c4df742c9 | MIT (LICENSE) | js/adapters/drafting-xlsx.js (Parts, Download Excel) |
| jszip-3.10.1 | npm jszip 3.10.1, dist/jszip.min.js | acc7e41455a80765b5fd9c7ee1b8078a6d160bbbca455aeae854de65c947d59e | MIT or GPL-3.0 (LICENSE.markdown), used under MIT | js/adapters/package-files.js (checklists) |
| pdf-lib-1.17.1 | npm pdf-lib 1.17.1, dist/pdf-lib.min.js | 0f9a5cad07941f0826586c94e089d89b918c46e5c17cf2d5a3c6f666e3bc694f | MIT (LICENSE.md) | js/adapters/package-files.js (merging, stamping) |
| pdfjs-dist-4.10.38 | npm pdfjs-dist 4.10.38, build/pdf.min.mjs | 27fc2a057a00f92a4334ad06e17dbd7259912954e9fb7f76400bcca5fd190a9c | Apache 2.0 (LICENSE) | js/adapters/package-files.js (reading checklist PDFs) |
| pdfjs-dist-4.10.38 | npm pdfjs-dist 4.10.38, build/pdf.worker.min.mjs | 1baa1844c89c80a5b2797c916e75ab29254be46d8e9cb53cb6364d7aad84be36 | as above | its worker |

Checked 27 Nov 2026. SheetJS: two downloads from cdn.sheetjs.com, byte-identical;
SheetJS publishes 0.20.3 nowhere else that can be read without signing in. The
others: each npm package's tarball matched the registry's sha512 integrity, the
files and licences were taken from it, and the copies jsDelivr had been serving
were byte-identical to them.
