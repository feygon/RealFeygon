# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Security (2026-10-25)
- **Deploy:** `deploy.yml` now excludes `config/nickersonWikiReports.js` from the
  `rsync --delete`. Before this, a deploy that ran after the private overlay
  deleted that file, and the private module failed to load.
- **Docs:** `BURNRATE_TWO_REPO_DEPLOYMENT_AUDIT.md` gains a TL;DR, a contents
  list, a Privacy Boundary section (the private repo's `docs/` never deploys,
  because the server's `docs/` is public), and the rsync replay method used to
  verify the exclude lists. Stale claims about `npm install` in CI and about the
  superseded docs are corrected.
- **Docs:** `PRE_DEPLOYMENT_CHECKLIST.md` v3.1.0 adds a privacy check and an
  exclude-list re-test check to Gate 4.

### Planned
- **MERN Migration** - Transition from Handlebars to React frontend
  - See `docs/learning/` for migration planning documentation
  - Express backend remains, routes will become REST API endpoints
  - Business logic in callbacks preserved as API controllers

---

## [2.2.0] - 2026-03-09

### Added
- **Condo maintenance slider**: Added to advanced parameters ($0-$6,000/yr, step $100)
- **Tax Deductions column**: Shows Schedule A/E split "(Xk A / Yk E)". Yellow warning triangle when standard deduction used.
- **Tax Deductions tooltip**: Reorganized into "Schedule A (Personal)" and "Schedule E (Rental)" sections with subtotals. Standard deduction warning at top when applicable. "See Base Expenses" reference for rental expenses.
- **countItems helper**: Excludes `lifestyle` from count (shown separately below total line)
- **Slider JS**: Added condo_maintenance to paramMap and updateParamDisplay

### Changed
- **Expenses tooltip overhaul**: Added condo HOA/tax/insurance/maintenance/deferred maintenance, C3 condo, SNT trust admin, legal/setup costs sections. Tax deductibility markers: * for Schedule A, † for Schedule E. Legend at bottom.
- **Tax Deductions column**: Removed redundant "(itemized)" label.

---

## [2.1.2] - 2025-01-07

### Fixed
- **Database Connection**
  - Resolved persistent authentication issues caused by orphaned `.env` file
  - Disabled `dotenv` loading in production (DirectAdmin manages environment variables)
  - Hardcoded database username temporarily to ensure stable connection
  - Reset MySQL user passwords for `realfey_realfey_realfeyuser`
  - Production database now connecting successfully

- **Sidebar Navigation**
  - Added navigation links to homepage sidebar (Home, Login, Space Station, etc.)
  - Added navigation links to player page sidebar (Home, ReadMe, Resume)
  - Confirmed existing sidebars working correctly (industry, space_station, out_in_space)

### Changed
- **Deployment Pipeline**
  - Added automatic `.env` file removal step to GitHub Actions workflow
  - Ensures DirectAdmin environment variables take precedence over file-based config
  - Prevents future authentication issues from stale configuration files

### Technical Details
- **Files Modified:**
  - `dbcon.js` - Commented out dotenv, hardcoded username
  - `main.js` - Commented out dotenv for production
  - `.github/workflows/deploy.yml` - Added `.env` removal step
  - `views/homepage.handlebars` - Added sidebar navigation
  - `views/player.handlebars` - Added sidebar navigation

- **Deployment:**
  - 6 commits pushed to resolve database and navigation issues
  - All changes deployed and verified in production
  - Site operational at https://www.realfeygon.com/eve2/

---

## [2.1.1] - 2025-01-07

### Verified
- **Production Deployment**
  - All v2.1.0 fixes verified in production environment
  - Spell URL corrections confirmed working
  - Sustained duration logic validated
  - Test coverage maintained at 100%

### Changed
- **Version Numbering**
  - Incremented to 2.1.1 for future changes
  - Preparing codebase for MERN migration (v3.0.0)

---

## [2.1.0] - 2025-01-07

### Fixed
- **Illusion Spell Formatting**
  - Fixed sustained duration logic to follow Pathfinder 2E rules
  - "sustained" alone or "sustained up to 10 min" now correctly classified as long duration
  - "sustained up to 1 min" or "sustained up to X rounds" now correctly classified as short duration
  - Added "unlimited" to long duration classification
  - Fixed area formatting to preserve hyphenated forms (e.g., "30-foot" ? "30-ft.", not "30'")

- **Duplicate Header**
  - Removed duplicate "Subjective Categorizations" header on illusion page

- **Spell URLs**
  - Corrected 45 incorrect Archive of Nethys URLs in illusion spell database
  - All spell links now point to correct pages

### Added
- **Test Coverage**
  - Added comprehensive test suite for Handlebars helpers (124 tests)
  - Achieved 100% branch coverage for helper functions
  - Tests cover all spell formatting edge cases
  - Added Istanbul ignore directives for unreachable error handling code

- **Documentation**
  - Added CHANGELOG.md to track version history
  - Added learning documentation in `docs/learning/`:
    - MERN stack migration guides
    - Animals system analysis
    - Neuro-accessibility audit

### Changed
- **Test Configuration**
  - Added `.nyc_output/` and `coverage/` to `.gitignore`
  - Istanbul coverage artifacts no longer committed
  - Coverage reports generated locally for development

### Technical Details
- **Files Modified:**
  - `views/helpers/helpers.js` - Core formatting logic fixes
  - `test/unit/helpers.test.js` - Comprehensive test coverage
  - `views/partials/category_block.handlebars` - Removed duplicate header
  - `scripts/sql/illusions DDQ.sql` - Updated with corrected spell URLs
  - `.gitignore` - Added coverage directories

- **Database Updates:**
  - Created `scripts/sql/UPDATE_spell_urls.sql` for production database updates
  - Fixed 45 spell URLs in production database

---

## [2.0.0] - Previous Release

### Added
- Illusion spell categorization system with 14 subjective categories
- Archive of Nethys integration for spell details
- Handlebars helper utilities for spell formatting
- EVE2 space station management system
- Animal breeding system

---

## [1.0.0] - Initial Release

### Added
- Core EVE2 space station mechanics
- Basic database structure
- Player management system
- Cargo space and object tracking
