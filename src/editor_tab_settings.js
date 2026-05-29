// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io

/** @type {number} */
let tabSpaces = 4;

/**
 * @param {number} n
 * @returns {void}
 */
export function setTabSpaces(n) {
  tabSpaces = n === 2 ? 2 : 4;
}

/**
 * @returns {number}
 */
export function getTabSpaces() {
  return tabSpaces;
}
