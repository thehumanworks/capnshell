import { expect, test } from "bun:test";
import { sddlOthers } from "./config.js";

const user = "S-1-5-21-1-2-3-1001";

test("a DACL for only the user, SYSTEM and Administrators is private", () => {
  expect(sddlOthers(`D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${user})`, user)).toEqual([]);
  // As a profile's inherited entries appear, with CREATOR OWNER on new children only.
  expect(sddlOthers(`D:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${user})(A;OICIIOID;GA;;;CO)`, user)).toEqual([]);
});

test("other trustees, a missing DACL and a null DACL are not private", () => {
  expect(sddlOthers(`D:AI(A;OICIID;FA;;;${user})(A;OICIID;0x1200a9;;;BU)(A;;FR;;;WD)`, user)).toEqual(["BU", "WD"]);
  expect(sddlOthers(`D:(A;OICI;FA;;;S-1-5-21-1-2-3-1002)`, user)).toEqual(["S-1-5-21-1-2-3-1002"]);
  expect(sddlOthers(`D:(A;OICI;FA;;;CO)`, user)).toEqual(["CO"]);
  expect(sddlOthers("D:NO_ACCESS_CONTROL", user)).toHaveLength(1);
  expect(sddlOthers("", user)).toHaveLength(1);
});

test("deny entries do not make a directory shared", () => {
  expect(sddlOthers(`D:P(D;OICI;FA;;;WD)(A;OICI;FA;;;${user})`, user)).toEqual([]);
});

test("the icacls /save file's name line comes before the DACL", () => {
  expect(sddlOthers(`.cns\r\nD:PAI(A;OICI;FA;;;${user})(A;OICI;FA;;;AU)\r\n`, user)).toEqual(["AU"]);
});

test("the local Administrator account, which SDDL writes as LA, is the user when the user is that account", () => {
  const administrator = "S-1-5-21-1-2-3-500";
  expect(sddlOthers("D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;LA)", administrator)).toEqual([]);
  expect(sddlOthers("D:PAI(A;OICI;FA;;;LA)", user)).toEqual(["LA"]);
  expect(sddlOthers("D:PAI(A;OICI;FA;;;LG)", user)).toEqual(["LG"]);
});
