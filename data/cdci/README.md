# CDCI medicine data

The medicine catalogue is loaded from **Common Drug Codes for India (CDCI)**, published by C-DAC / NRCeS for the
Ministry of Health and Family Welfare under CC BY 4.0. The `*.txt` files are not committed (about 19 MB).

1. Download the latest flat-file package from the NRCeS national releases page (https://www.nrces.in/), or from the
   CC BY mirror at https://github.com/ohcnetwork/cdci (folder `data/source`).
2. Put the TSV files (`BrandMaster.txt`, `GenericMaster.txt`, `SupplierMaster.txt`, `RouteOfAdministrationMaster.txt`, ...)
   in this folder.
3. Run `npm run medicines:import` (or `npm run medicines:import -- <folder>`).

Attribution shown in the apps: "Medicine names from Common Drug Codes for India (CDCI), © C-DAC / NRCeS, MoHFW, CC BY 4.0."
Brand names belong to their owners. See docs/operations.md, "Medicine catalogue (CDCI)".
