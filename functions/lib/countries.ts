/**
 * sevdesk's ids for countries (its `StaticCountry` list), by ISO 3166-1 alpha-2 code. The
 * list is the same for every sevdesk account. Read from `GET /StaticCountry` on 2026-10-12;
 * for the two codes sevdesk lists more than once, the United Kingdom and the United Arab
 * Emirates are the rows chosen.
 */
const COUNTRY_IDS: Record<string, number> = {
  AD: 1418, AE: 44, AF: 4, AG: 1449, AI: 1467, AL: 1347, AM: 1348, AO: 1466, AQ: 1470, AR: 5,
  AS: 1469, AT: 3, AU: 38, AW: 1465, AX: 1468, AZ: 33, BA: 1396, BB: 1445, BD: 1440, BE: 6,
  BF: 1473, BG: 7, BH: 1427, BI: 1404, BJ: 1472, BL: 1474, BM: 1476, BN: 1479, BO: 1477, BQ: 1478,
  BR: 73, BS: 1426, BT: 1350, BV: 1480, BW: 1481, BY: 76, BZ: 46, CA: 1423, CC: 1483, CD: 1484,
  CF: 1482, CG: 1485, CH: 2, CI: 1381, CK: 1486, CL: 49, CM: 1400, CN: 60, CO: 1403, CR: 1421,
  CU: 1488, CV: 1487, CW: 1455, CX: 1489, CY: 1490, CZ: 30, DE: 1, DJ: 1405, DK: 8, DM: 1491,
  DO: 1447, DZ: 1458, EC: 1492, EE: 1390, EG: 1383, EH: 1493, ER: 1406, ES: 29, ET: 1399, FI: 10,
  FJ: 1494, FK: 1495, FM: 1497, FO: 1496, FR: 11, GA: 1498, GB: 77, GD: 1504, GE: 1394, GF: 1507,
  GG: 1499, GH: 1382, GI: 1500, GL: 1505, GM: 1501, GN: 1376, GP: 1438, GQ: 1503, GR: 12, GS: 1537,
  GT: 1506, GU: 1508, GW: 1502, GY: 1509, HK: 59, HM: 1510, HN: 1511, HR: 48, HT: 1512, HU: 31,
  ID: 1374, IE: 13, IL: 36, IM: 1513, IN: 1375, IO: 1514, IQ: 1419, IR: 1373, IS: 51, IT: 14,
  JE: 1515, JM: 15, JO: 1344, JP: 40, KE: 1389, KG: 1430, KH: 1401, KI: 1516, KM: 1407, KN: 1433,
  KP: 1453, KR: 41, KW: 1369, KY: 1460, KZ: 56, LA: 1518, LB: 1428, LC: 1448, LI: 42, LK: 1356,
  LR: 1519, LS: 1520, LT: 1346, LU: 17, LV: 16, LY: 1454, MA: 1365, MC: 43, MD: 1362, ME: 1343,
  MF: 1521, MG: 1395, MH: 1523, MK: 1367, ML: 1461, MM: 1359, MN: 1360, MO: 61, MP: 1524, MQ: 1385,
  MR: 1364, MS: 1363, MT: 37, MU: 1525, MV: 1435, MW: 1408, MX: 64, MY: 1387, MZ: 1410, NA: 1429,
  NC: 1526, NE: 1527, NF: 1528, NG: 32, NI: 1529, NL: 18, NO: 19, NP: 1462, NR: 1531, NU: 1530,
  NZ: 50, OM: 1357, PA: 1446, PE: 69, PF: 1351, PG: 1534, PH: 1392, PK: 55, PL: 21, PM: 1540,
  PN: 1532, PR: 1436, PS: 1464, PT: 22, PW: 1533, PY: 1393, QA: 1371, RE: 1535, RO: 23, RS: 1425,
  RU: 24, RW: 1411, SA: 57, SB: 1539, SC: 1388, SD: 1536, SE: 25, SG: 75, SH: 1475, SI: 28,
  SJ: 1538, SK: 27, SL: 1378, SM: 1451, SN: 1439, SO: 1414, SR: 1542, SS: 1415, ST: 1541, SV: 1450,
  SX: 1544, SY: 1545, SZ: 1543, TC: 1546, TD: 1547, TF: 1471, TG: 1463, TH: 1380, TJ: 1548, TK: 1549,
  TL: 1551, TM: 1550, TN: 1354, TO: 1552, TR: 34, TT: 1553, TV: 1554, TW: 1424, TZ: 1416, UA: 66,
  UG: 1417, UM: 1555, US: 1353, UY: 1384, UZ: 1342, VA: 1556, VC: 1557, VE: 1558, VG: 1391, VI: 1559,
  VN: 1352, VU: 1560, WF: 1561, WS: 1562, XK: 1422, YE: 1459, YT: 1409, ZA: 47, ZM: 1412, ZW: 1413,
};

export function countryId(code: string | undefined | null): number | undefined {
  return code ? COUNTRY_IDS[code.toUpperCase()] : undefined;
}
