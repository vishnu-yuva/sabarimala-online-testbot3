// uthai.js

const { chromium } = require('playwright');

// Set these as environment variables before running the script.
//   Windows (cmd):        set SABARI_USER=xxxx && set SABARI_PASS=xxxx && node uthai.js
//   Windows (PowerShell): $env:SABARI_USER="xxxx"; $env:SABARI_PASS="xxxx"; node uthai.js
const USERNAME = process.env.SABARI_USER || '';
const PASSWORD = process.env.SABARI_PASS || '';

// -------------------------------------------------------------------------
// --- 1. CONFIGURATION CONSTANTS ---
// -------------------------------------------------------------------------

// Dates to check (use 3-letter month format: Jan, Feb, Mar, Apr, May, Jun, Jul, Aug, Sep, Oct, Nov, Dec)
// Put your most preferred date FIRST. The first one found available is selected.
const TARGET_DATES = [
    { label: 'Nov 19', day: '19', month: 'Nov', year: '2026' },
    // { label: 'Jan 10', day: '10', month: 'Jan', year: '2027' },
    // { label: 'Jan 14', day: '14', month: 'Jan', year: '2027' },
];

// Pilgrim rows to tick on the pilgrim selection page (row numbers, starting from 1).
// Example: [1, 3] selects the 1st and 3rd pilgrim rows.
const PILGRIM_ROWS = [2,3,4,5];

// Nominee details. The site has one nominee row per selected pilgrim, and this
// SAME nominee is filled in EVERY row (2, 3, 4, 5 pilgrims... any count).
//   name:     letters and spaces only, max 32 characters
//   age:      digits only, max 3 digits
//   relation: Father, Mother, Son, Daughter, Brother, Sister, Spouse
const DEFAULT_NOMINEE = { name: 'Example Nominee', age: '30', relation: 'Father' };

// Optional: use a different nominee for a specific pilgrim row (row number starts at 1).
// Rows not listed here use DEFAULT_NOMINEE.
const NOMINEE_OVERRIDES = {
    // 2: { name: 'Kumar', age: '28', relation: 'Brother' },
};

// Relation name -> dropdown option value on the site
const RELATION_VALUES = {
    father: '1',
    mother: '2',
    son: '3',
    daughter: '4',
    brother: '5',
    sister: '6',
    spouse: '11',
};

// The specific Route option value for "Pamba - Marakkoottam - 4 Kms"
const ROUTE_VALUE = '1';
const ROUTE_SELECTOR = 'select[name="reportingPlace"]';

// Selector for any available time slot div (used to check if slots loaded)
const AVAILABLE_SLOT_SELECTOR = 'div.slot-dar-5:has-text("Availability:")';

// Selector for the clickable parent element of the time slot
const TIME_SLOT_CLICK_PARENT = '.slot-media:has(.slot-dar-5:has-text("Availability:"))';

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// --- Multi-round booking settings ---
// If a round fails (no slot, page error...), the whole flow restarts from the first step.
// Stop only after this many failures in a row, so a permanent problem does not loop forever.
const MAX_CONSECUTIVE_FAILURES = 20;
const RETRY_DELAY_MS = 5000;

// Remembers who each pilgrim row is (by its text), so after some pilgrims are booked
// and the list changes, the remaining ones are still found correctly.
const pilgrimIdentity = {};

// -------------------------------------------------------------------------
// --- 2. MAIN EXECUTION FUNCTION ---
// -------------------------------------------------------------------------

async function runBookingBot() {
    let browser;
    try {
        // Launch your installed Google Chrome instead of Playwright's bundled Chromium.
        // If 'channel: "chrome"' fails, comment it out and uncomment 'executablePath'.
        browser = await chromium.launch({
            channel: 'chrome',
            // executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            headless: false
        });
        const page = await browser.newPage();

        let remaining = [...PILGRIM_ROWS]; // pilgrim rows still NOT booked
        let failures = 0;
        let round = 0;

        while (remaining.length > 0) {
            round++;
            console.log(`\n==================== ROUND ${round} ====================`);
            console.log(`Pilgrims still to book (rows): ${remaining.join(', ')}`);

            try {
                const bookedRows = await runOneRound(page, remaining);

                if (!bookedRows || bookedRows.length === 0) {
                    throw new Error('No pilgrim could be booked in this round.');
                }

                // No payment is needed, so once the final steps finish the booking is considered done.
                remaining = remaining.filter((r) => !bookedRows.includes(r));
                failures = 0;
                console.log(`✅ Booked row(s): ${bookedRows.join(', ')}. Remaining: ${remaining.length ? remaining.join(', ') : 'none'}`);
            } catch (err) {
                failures++;
                console.error(`⚠️ Round ${round} failed (${failures}/${MAX_CONSECUTIVE_FAILURES}): ${err.message.split('\n')[0]}`);
                if (failures >= MAX_CONSECUTIVE_FAILURES) {
                    console.log('🛑 Too many failures in a row. Stopping automation.');
                    break;
                }
                console.log(`Restarting from the initial step in ${RETRY_DELAY_MS / 1000} seconds...`);
                await page.waitForTimeout(RETRY_DELAY_MS);
            }
        }

        if (remaining.length === 0) {
            console.log('\n🎉 ALL PILGRIMS ARE BOOKED. Automation finished.');
        } else {
            console.log(`\n🛑 Automation stopped. Pilgrim rows NOT booked: ${remaining.join(', ')}`);
        }

    } catch (error) {
        console.error('--- 🛑 AN UNRECOVERABLE ERROR OCCURRED ---', error);
    } finally {
        if (browser) {
            // await browser.close(); // Uncomment to close the browser automatically
        }
    }
}

/**
 * One full booking pass (login -> date -> route/slot -> pilgrims -> nominees -> payment screen)
 * for as many of the remaining pilgrims as the chosen slot has room for.
 * Returns the list of pilgrim rows that were selected in this pass.
 */
async function runOneRound(page, remaining) {
    console.log('--- STARTING LOGIN & NAVIGATION ---');
    await loginAndOpenBookingPage(page);

    // Date selection (loops/refreshes until the target date is available)
    const dateSelected = await selectDateOnly(page);
    if (!dateSelected) {
        throw new Error('Failed to select a date.');
    }

    // Route + slot. The slot's availability decides how many pilgrims we can book now.
    const slot = await selectRouteAndSlot(page, remaining.length);
    if (!slot.ok) {
        throw new Error('Failed to select a slot after route selection.');
    }

    const countThisRound = Math.min(slot.availability, remaining.length);
    const rowsThisRound = remaining.slice(0, countThisRound);

    if (countThisRound < remaining.length) {
        console.log(`ℹ️ Only ${slot.availability} seat(s) available but ${remaining.length} pilgrim(s) remain. Booking ${countThisRound} now, the rest in the next round.`);
    } else {
        console.log(`ℹ️ Enough seats (${slot.availability}) for all ${remaining.length} remaining pilgrim(s).`);
    }

    // Select "Others (Upto 5 Pilgrims)"
    await page.click('#mat-radio-3');
    console.log('Selected "Others" group option.');

    // Click Select Pilgrim Button
    await Promise.all([
        page.waitForURL('**/piligrimServiceMaster', { timeout: 15000 }),
        page.click('button:has-text("Select Pilgrim")')
    ]);
    console.log('Clicked "Select Pilgrim" and navigated to selection page.');

    // Select only the pilgrims that fit
    const selectedRows = await selectPilgrims(page, rowsThisRound);
    if (selectedRows.length === 0) {
        throw new Error('No pilgrim could be ticked on the selection page.');
    }

    // Submit on pilgrim page
    await Promise.all([
        page.waitForURL('**/darshan', { timeout: 15000 }),
        page.click('button#regi_continue:has-text("Submit")')
    ]);
    console.log('Clicked Submit on Pilgrim page and returned to darshan page.');

    // Nominee details (every nominee row on the page)
    await fillNominees(page);

    // "No" for both contribution options
    await selectContributionNo(page);

    // Wishlist & payment steps
    await handleFinalSteps(page);

    return selectedRows;
}

// -------------------------------------------------------------------------
// --- 3. HELPER FUNCTIONS ---
// -------------------------------------------------------------------------

/**
 * Initial steps: open the site, login if needed, and go to the Virtual-Q booking page.
 * Safe to call again for every round.
 */
async function loginAndOpenBookingPage(page) {
    await page.goto('https://sabarimalaonline.org/#/darshan');

    let needLogin = false;
    try {
        await page.waitForSelector('#email', { state: 'visible', timeout: 6000 });
        needLogin = true;
    } catch (e) {
        needLogin = false;
    }

    if (needLogin) {
        await page.fill('#email', USERNAME);
        await page.fill('#password', PASSWORD);
        await Promise.all([
            page.waitForURL('**/home', { timeout: 15000 }),
            page.click('#regi_continue')
        ]);
        console.log('Login attempt successful.');
    } else {
        console.log('Already logged in.');
    }

    if (!page.url().includes('/darshan')) {
        await page.waitForSelector('#container', { state: 'visible', timeout: 10000 });
        await Promise.all([
            page.waitForURL('**/darshan', { timeout: 15000 }),
            page.click('#container')
        ]);
    }
    console.log('Navigated to Virtual-Q booking page.');

    await page.waitForSelector(ROUTE_SELECTOR, { state: 'visible', timeout: 10000 });
    console.log('Booking page elements are stable. Starting checks.');
}

/**
 * Builds an exact-match regex for a calendar cell's aria-label.
 * Matches: "Dec 20 2026", "Dec 20, 2026", "December 20, 2026", "December 20 2026", "Dec 020 2026" (leading zero)
 * Does NOT match "Dec 2 2026", "Dec 21 2026", etc.
 */
function buildLabelRegex(targetDate) {
    const dayNum = String(parseInt(targetDate.day, 10));
    return new RegExp(
        `^${targetDate.month}[a-z]*\\.?\\s+0?${dayNum},?\\s+${targetDate.year}$`,
        'i'
    );
}

/**
 * Dynamically navigates the Angular Material calendar to the exact month and year
 * specified in TARGET_DATES and selects the exact target day (only if it is enabled).
 */
async function selectDateOnly(page) {
    console.log('--- STARTING DATE CHECK LOOP (Dynamic Month/Year Navigation) ---');

    const nextMonthBtn = page.locator('button.mat-calendar-next-button[aria-label="Next month"]');
    const prevMonthBtn = page.locator('button.mat-calendar-previous-button[aria-label="Previous month"]');
    const periodHeader = page.locator('.mat-calendar-period-button');
    const calendarToggleButton = page.locator('mat-datepicker-toggle');

    while (true) {
        let dateFound = false;
        try {
            await page.waitForSelector('svg.mat-datepicker-toggle-default-icon', { timeout: 5000 });
            console.log('Calendar loaded. Checking available dates...');

            // Open calendar
            await calendarToggleButton.click({ force: true });
            await page.waitForSelector('.mat-calendar-body', { state: 'visible', timeout: 5000 });

            for (const targetDate of TARGET_DATES) {
                const targetMonthIndex = MONTH_NAMES.indexOf(targetDate.month.toUpperCase());
                const targetYear = parseInt(targetDate.year, 10);

                if (targetMonthIndex === -1) {
                    console.log(`⚠️ Invalid month format in TARGET_DATES: "${targetDate.month}". Use 3-letter format (e.g., Nov, Dec, Jan).`);
                    continue;
                }

                // Navigate forward or backward up to 12 months until header matches target month & year
                for (let step = 0; step < 12; step++) {
                    const headerText = (await periodHeader.innerText()).trim().toUpperCase();
                    const currentMonthIndex = MONTH_NAMES.findIndex(m => headerText.includes(m));
                    const yearMatch = headerText.match(/\d{4}/);
                    const currentYear = yearMatch ? parseInt(yearMatch[0], 10) : targetYear;

                    // Stop navigating once calendar displays the target month and year
                    if (currentMonthIndex === targetMonthIndex && currentYear === targetYear) {
                        break;
                    }

                    const isTargetAhead =
                        targetYear > currentYear ||
                        (targetYear === currentYear && targetMonthIndex > currentMonthIndex);

                    if (isTargetAhead) {
                        if (await nextMonthBtn.isDisabled()) {
                            console.log(`⚠️ Cannot navigate further forward to ${targetDate.month} ${targetDate.year} (Next button disabled).`);
                            break;
                        }
                        await nextMonthBtn.click();
                    } else {
                        if (await prevMonthBtn.isDisabled()) {
                            console.log(`⚠️ Cannot navigate further backward to ${targetDate.month} ${targetDate.year} (Previous button disabled).`);
                            break;
                        }
                        await prevMonthBtn.click();
                    }

                    // Brief pause so Angular re-renders the month grid before reading the header again
                    await page.waitForTimeout(250);
                }

                // Confirm the calendar really landed on the target month/year before looking for the day
                const finalHeader = (await periodHeader.innerText()).trim().toUpperCase();
                const finalYearMatch = finalHeader.match(/\d{4}/);
                const onTargetMonth =
                    finalHeader.includes(MONTH_NAMES[targetMonthIndex]) &&
                    finalYearMatch &&
                    parseInt(finalYearMatch[0], 10) === targetYear;

                if (!onTargetMonth) {
                    console.log(`⚠️ Calendar is showing "${finalHeader}", not ${targetDate.month} ${targetDate.year}. Skipping.`);
                    continue;
                }

                // Find the exact day cell in the month currently displayed.
                // The calendar is already on the target month/year (checked above), so the
                // visible day number is the most reliable thing to match. aria-label is a fallback.
                const dayNum = String(parseInt(targetDate.day, 10));
                const labelRegex = buildLabelRegex(targetDate);
                const cells = page.locator('td.mat-calendar-body-cell');
                const count = await cells.count();
                let dateCell = null;
                let dayExistsButUnavailable = false;
                const debugRows = [];

                for (let i = 0; i < count; i++) {
                    const cell = cells.nth(i);
                    const text = ((await cell.innerText()) || '').trim();
                    const label = ((await cell.getAttribute('aria-label')) || '').trim();
                    const cls = (await cell.getAttribute('class')) || '';
                    const ariaDisabled = await cell.getAttribute('aria-disabled');

                    debugRows.push(`text="${text}" | label="${label}" | disabled=${ariaDisabled} | class="${cls}"`);

                    const dayMatches = text === dayNum || labelRegex.test(label);
                    if (!dayMatches) continue;

                    const isDisabled = ariaDisabled === 'true' || cls.includes('mat-calendar-body-disabled');
                    const isAvailable = cls.includes('example-custom-date-class');

                    if (isAvailable && !isDisabled) {
                        dateCell = cell;
                        break;
                    } else {
                        dayExistsButUnavailable = true;
                    }
                }

                if (!dateCell) {
                    if (dayExistsButUnavailable) {
                        console.log(`ℹ️ ${targetDate.label} ${targetDate.year} is in the calendar but not available yet.`);
                    } else {
                        console.log(`⚠️ Could not find a cell for ${targetDate.label} ${targetDate.year}. Cells seen:`);
                        debugRows.forEach(r => console.log('   ' + r));
                    }
                }

                if (dateCell && await dateCell.isVisible()) {
                    console.log(`✅ Date Available: ${targetDate.label} ${targetDate.year}. Selecting...`);

                    await Promise.all([
                        page.waitForSelector('.mat-calendar-body', { state: 'hidden', timeout: 5000 }),
                        dateCell.click({ force: true })
                    ]);

                    dateFound = true;
                    break;
                }
            }

            if (dateFound) {
                console.log('--- ✅ DATE SELECTED. Proceeding to Route Selection. ---');
                return true;
            } else {
                await calendarToggleButton.click({ force: true });
                console.log('No available dates. Refreshing after 7 seconds...');
                await page.waitForTimeout(7000);
                await page.reload();
            }

        } catch (err) {
            console.log(`Error while checking dates: ${err.message.split('\n')[0]}`);
            await page.waitForTimeout(7000);
            await page.reload();
        }
    }
}

/**
 * Selects the route and then picks a slot based on its "Availability: N" number.
 *  - Prefers the first slot that has enough seats for ALL pilgrims still needed.
 *  - If no slot is big enough, picks the slot with the MOST seats (partial booking).
 * Returns { ok, availability } where availability is the seat count of the chosen slot.
 */
async function selectRouteAndSlot(page, neededCount) {
    console.log('--- STARTING ROUTE SELECTION ---');

    await page.waitForSelector(`${ROUTE_SELECTOR}:not([disabled])`, {
        state: 'visible',
        timeout: 10000,
    });

    await page.selectOption(ROUTE_SELECTOR, ROUTE_VALUE);

    const finalValue = await page.$eval(ROUTE_SELECTOR, el => el.value);

    if (finalValue !== ROUTE_VALUE) {
        console.log(`⚠️ Expected route value "${ROUTE_VALUE}" but got: ${finalValue}. Cannot proceed.`);
        return { ok: false, availability: 0 };
    } else {
        console.log('✅ Route selected: Pamba - Marakkoottam - 4 Kms');
    }

    console.log('--- STARTING SLOT SELECTION ---');

    try {
        await page.waitForSelector(AVAILABLE_SLOT_SELECTOR, { timeout: 10000 });
        await page.waitForTimeout(500); // let all slot cards finish rendering

        const slots = page.locator(TIME_SLOT_CLICK_PARENT);
        const slotCount = await slots.count();

        // Read the seat count of every slot
        const slotInfo = [];
        for (let i = 0; i < slotCount; i++) {
            const text = (await slots.nth(i).locator('.slot-dar-5').first().innerText()) || '';
            const m = text.match(/Availability:\s*(\d+)/i);
            const seats = m ? parseInt(m[1], 10) : null; // null = could not read the number
            slotInfo.push({ index: i, seats });
        }
        console.log('Slots found: ' + slotInfo.map(s => `#${s.index + 1}=${s.seats === null ? '?' : s.seats}`).join(', '));

        // Ignore slots that clearly have 0 seats
        const usable = slotInfo.filter(s => s.seats === null || s.seats > 0);
        if (usable.length === 0) {
            console.log('⚠️ Route selected, but every slot has 0 seats.');
            return { ok: false, availability: 0 };
        }

        // Best choice: first slot that fits everyone; otherwise the slot with the most seats
        let chosen = usable.find(s => s.seats === null || s.seats >= neededCount);
        if (!chosen) {
            chosen = usable.reduce((best, s) => (s.seats > best.seats ? s : best), usable[0]);
        }

        const target = slots.nth(chosen.index);
        if (await target.isVisible()) {
            await target.click();
            const availability = chosen.seats === null ? neededCount : chosen.seats;
            console.log(`✅ Selected slot #${chosen.index + 1} (seats: ${chosen.seats === null ? 'unknown, assuming enough' : chosen.seats}).`);
            return { ok: true, availability };
        } else {
            console.log('⚠️ Route selected, but the chosen time slot is not visible.');
            return { ok: false, availability: 0 };
        }

    } catch (e) {
        console.log(`⚠️ Slot selection failed (Timeout or element not found): ${e.message.split('\n')[0]}`);
        return { ok: false, availability: 0 };
    }
}

const normalizeText = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Selects the given pilgrim rows (original row numbers from PILGRIM_ROWS).
 * Each pilgrim is remembered by the text of its row, so if the list changes after
 * earlier pilgrims are booked, the right person is still found.
 * Returns the list of original row numbers that were actually ticked.
 */
async function selectPilgrims(page, rowsToSelect) {
    console.log('--- STARTING PILGRIM SELECTION ---');

    await page.waitForSelector('mat-row', { timeout: 10000 });
    const rows = page.locator('mat-row');

    // Read the current list of row texts
    const readRowTexts = async () => {
        const n = await rows.count();
        const texts = [];
        for (let i = 0; i < n; i++) {
            texts.push(normalizeText(await rows.nth(i).innerText()));
        }
        return texts;
    };

    // First time on this page: remember who is in each configured row
    let currentTexts = await readRowTexts();
    for (const rowIndex of PILGRIM_ROWS) {
        if (!(rowIndex in pilgrimIdentity) && currentTexts[rowIndex - 1]) {
            pilgrimIdentity[rowIndex] = currentTexts[rowIndex - 1];
        }
    }

    const selectedRows = [];

    for (const originalRow of rowsToSelect) {
        // Find where this pilgrim is on the page right now
        let currentIndex = originalRow; // default: same row number
        const identity = pilgrimIdentity[originalRow];

        if (identity) {
            const found = currentTexts.findIndex(t => t === identity || t.includes(identity) || identity.includes(t));
            if (found === -1) {
                console.log(`⚠️ Pilgrim of original row ${originalRow} is not on the list now. Skipping.`);
                continue;
            }
            currentIndex = found + 1;
        }

        const checkboxSelector = `//mat-row[${currentIndex}]//mat-checkbox`;
        const inputSelector = `//mat-row[${currentIndex}]//mat-checkbox//input[@type="checkbox"]`;
        const checkbox = page.locator(checkboxSelector);
        const inputElement = page.locator(inputSelector);

        try {
            await inputElement.waitFor({ state: 'attached', timeout: 3000 });

            const isChecked = (await inputElement.getAttribute('aria-checked')) === 'true';

            if (!isChecked) {
                await checkbox.click();
                selectedRows.push(originalRow);
                console.log(`✅ Selected Pilgrim (original row ${originalRow}, currently row ${currentIndex})`);
            } else {
                console.log(`Pilgrim at row ${currentIndex} was already selected or unavailable.`);
            }

        } catch (e) {
            console.log(`⚠️ Pilgrim at row ${currentIndex} not available or failed to click. Error: ${e.message.split('\n')[0]}`);
        }
    }
    console.log(`Total pilgrims selected: ${selectedRows.length}`);
    return selectedRows;
}

/**
 * Fills the nominee table. The site shows one nominee row per selected pilgrim,
 * so this loops over every row on the page and fills each one with DEFAULT_NOMINEE
 * (or a per-row entry from NOMINEE_OVERRIDES). Works for any number of pilgrims.
 */
async function fillNominees(page) {
    console.log('--- STARTING NOMINEE DETAILS ---');

    const ROW_SELECTOR = '#nominee-table-wrapper tbody tr';
    const NAME_INPUT = 'input[placeholder="Enter Nominee Name"]';
    const AGE_INPUT = 'input[placeholder="Enter Age"]';

    // Wait for the first nominee row to appear
    await page.waitForSelector(`${ROW_SELECTOR} ${NAME_INPUT}`, { state: 'visible', timeout: 10000 });

    // Rows can render one by one, so wait until the row count stops changing
    const rows = page.locator(ROW_SELECTOR);
    let rowCount = await rows.count();
    for (let attempt = 0; attempt < 10; attempt++) {
        await page.waitForTimeout(300);
        const current = await rows.count();
        if (current === rowCount) break;
        rowCount = current;
    }
    console.log(`Found ${rowCount} nominee row(s). Filling all of them.`);

    for (let i = 0; i < rowCount; i++) {
        const rowNumber = i + 1;
        const nominee = NOMINEE_OVERRIDES[rowNumber] || DEFAULT_NOMINEE;
        const row = rows.nth(i);

        const name = String(nominee.name).trim();
        const age = String(nominee.age).trim();
        const relationValue = RELATION_VALUES[String(nominee.relation).trim().toLowerCase()];

        // Validate against the site's own rules before typing
        if (!/^[a-zA-Z ]+$/.test(name) || name.length > 32) {
            console.log(`⚠️ Row ${rowNumber}: name "${name}" must be letters/spaces only, max 32 chars. Skipping this row.`);
            continue;
        }
        if (!/^[0-9]{1,3}$/.test(age)) {
            console.log(`⚠️ Row ${rowNumber}: age "${age}" must be 1 to 3 digits. Skipping this row.`);
            continue;
        }
        if (!relationValue) {
            console.log(`⚠️ Row ${rowNumber}: unknown relation "${nominee.relation}". Use: ${Object.keys(RELATION_VALUES).join(', ')}. Skipping this row.`);
            continue;
        }

        await row.scrollIntoViewIfNeeded();
        await row.locator(NAME_INPUT).fill(name);
        await row.locator(AGE_INPUT).fill(age);
        await row.locator('select').selectOption(relationValue);

        // Blur the last field so Angular marks the row as touched/valid
        await row.locator(AGE_INPUT).press('Tab');

        console.log(`✅ Row ${rowNumber} filled: ${name}, ${age}, ${nominee.relation}`);
    }

    console.log('--- ✅ NOMINEE DETAILS DONE ---');
}

/**
 * Selects "No" in both contribution sections:
 *   1. Contribute for Pilgrim Relief fund   (radio group name="contribute")
 *   2. Clean Sabarimala Project (Optional)  (radio group name="sanityYesOrNo")
 * Radio ids like #mat-radio-12 change between page loads, so we find each group by its
 * name and pick the "no" option inside it.
 */
async function selectContributionNo(page) {
    console.log('--- STARTING CONTRIBUTION OPTIONS ---');

    const groups = [
        { name: 'contribute', label: 'Pilgrim Relief fund', required: true },
        { name: 'sanityYesOrNo', label: 'Clean Sabarimala Project', required: false },
    ];

    for (const group of groups) {
        const noButton = page.locator(`mat-radio-group[name="${group.name}"] mat-radio-button[value="no"]`);

        try {
            await noButton.waitFor({ state: 'visible', timeout: group.required ? 10000 : 5000 });
        } catch (e) {
            if (group.required) {
                throw new Error(`"${group.label}" contribution option not found on the page.`);
            }
            console.log(`ℹ️ "${group.label}" option not shown. Skipping.`);
            continue;
        }

        await noButton.scrollIntoViewIfNeeded();
        await noButton.locator('label').click();

        const cls = (await noButton.getAttribute('class')) || '';
        if (cls.includes('mat-radio-checked')) {
            console.log(`✅ Selected "No" for ${group.label}.`);
        } else {
            console.log(`⚠️ Clicked "No" for ${group.label}, but it does not look selected. Check the page.`);
        }
    }

    console.log('--- ✅ CONTRIBUTION OPTIONS DONE ---');
}

/**
 * Handles the wishlist and proceed steps to reach payment.
 */
async function handleFinalSteps(page) {
    console.log('--- STARTING FINAL CHECKOUT STEPS ---');

    // 3. Click "Add to Wishlist"
    await page.click('button#regi_continue:has-text("Add to Wishlist")');
    console.log('Clicked "Add to Wishlist".');

    // 4. Click first "Proceed" button
    await Promise.all([
        page.waitForURL('**/paymentGateway', { timeout: 15000 }),
        page.click('button:has-text("Proceed")')
    ]);
    console.log('Clicked first "Proceed" button and navigated to Payment Gateway.');

    // 5. Click the final "Proceed" button on the payment gateway
    await page.click('button#regi_continue:has-text("Proceed")');
    console.log('Clicked final "Proceed" button on Payment Gateway.');

    // Give the site a moment to register the booking before the next round starts
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(3000);

    console.log('--- ✅ AUTOMATION COMPLETE: NOW AT PAYMENT SCREEN ---');
}

// -------------------------------------------------------------------------
// --- 4. EXECUTION ---
// -------------------------------------------------------------------------

runBookingBot();