# NEMAR CLI

[![License: CC BY-NC-ND 4.0](https://img.shields.io/badge/License-CC%20BY--NC--ND%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc-nd/4.0/)
[![Documentation](https://img.shields.io/badge/docs-docs.nemar.org-blue)](https://docs.nemar.org)
[![Tests](https://github.com/nemarOrg/nemar-cli/actions/workflows/test.yml/badge.svg)](https://github.com/nemarOrg/nemar-cli/actions/workflows/test.yml)

Command-line interface for [NEMAR](https://nemar.org) (Neuroelectromagnetic Data Archive and Tools Resource) dataset management.

**[Documentation](https://docs.nemar.org)** | [Quick Start](https://docs.nemar.org/cli/getting-started/quickstart/) | [Commands](https://docs.nemar.org/cli/commands/)

> Documentation now lives in its own repository, [nemarOrg/docs](https://github.com/nemarOrg/docs) (Astro Starlight), and is published at [docs.nemar.org](https://docs.nemar.org).

## Features

- **Dataset Management**: Upload, download, validate, and version BIDS datasets
- **Resume Uploads**: Failed uploads can be resumed; CLI stores state in `.nemar/config.json`
- **Smart Authentication**: Verifies GitHub CLI authentication matches NEMAR user
- **Auto-Accept Invitations**: Automatically accepts GitHub collaboration invitations
- **IAM Retry Logic**: Handles AWS IAM eventual consistency with automatic retries
- **Commit Authorship**: Commits attributed to your NEMAR user identity
- **Private First**: New datasets are private; branch protection applied only on DOI creation
- **PR-Based Updates**: After DOI, all changes require pull requests
- **Collaborative**: Any NEMAR user can contribute to any dataset
- **BIDS Validation**: Automatic validation before upload and on PRs
- **DOI Integration**: Zenodo DOI creation for dataset versioning
- **DataLad Backend**: Git-annex for large file management with S3 storage

## Installation

Requires [Bun](https://bun.sh) runtime.

```bash
# Install Bun (if not already installed)
curl -fsSL https://bun.sh/install | bash

# Install NEMAR CLI
bun install -g nemar-cli

# Or run directly without installing
bunx nemar-cli
```

### Prerequisites

For dataset operations:

- [DataLad](https://www.datalad.org/) and git-annex
- [Deno](https://deno.land/) (for BIDS validation)
- [GitHub CLI](https://cli.github.com/) (`gh`) - authenticated as your NEMAR user
- SSH key registered with GitHub

```bash
# macOS
brew install datalad git-annex deno gh

# Ubuntu/Debian
sudo apt-get install git-annex
pip install datalad
curl -fsSL https://deno.land/install.sh | sh
# Install gh: https://github.com/cli/cli/blob/trunk/docs/install_linux.md

# Authenticate GitHub CLI (required for upload)
gh auth login
```

**Important:** The GitHub account authenticated with `gh` must match your NEMAR username. The CLI verifies this before upload.

## Quick Start

```bash
# 1. Sign up for NEMAR (opens your browser to sign in with ORCID, then a few quick questions)
nemar auth signup

# 2. Complete sandbox training
nemar sandbox

# 3. Validate your BIDS dataset
nemar dataset validate /path/to/dataset

# 4. Upload to NEMAR
nemar dataset upload /path/to/dataset
```

On another machine, `nemar auth login` signs in the same way (browser by default; `--key <api-key>`
pastes an existing key for a host that cannot open one).

## Architecture Overview

```mermaid
graph TB
    subgraph "User's Machine"
        CLI[NEMAR CLI]
        DL[DataLad]
    end

    subgraph "NEMAR Backend"
        API[Cloudflare Workers API]
        DB[(D1 Database)]
    end

    subgraph "Storage"
        GH[GitHub nemarDatasets]
        S3[(AWS S3)]
        ZEN[Zenodo DOI]
    end

    CLI --> API
    CLI --> DL
    DL --> GH
    DL --> S3
    API --> DB
    API --> GH
    API --> S3
    API --> ZEN
```

## Workflows

### User Registration & Authentication

```mermaid
sequenceDiagram
    participant U as User
    participant CLI as NEMAR CLI
    participant API as Backend
    participant Admin as Admin

    U->>CLI: nemar auth signup
    CLI->>API: Start browser sign-in (device flow, ADR 0047)
    U->>API: Sign in with ORCID in the browser
    API-->>U: Verification email
    U->>API: Click verification link
    API->>Admin: Notification: new user pending
    Admin->>CLI: nemar admin approve <user>
    CLI->>API: POST /admin/approve
    API-->>U: Approval email with instructions
    U->>CLI: nemar auth login
    CLI->>API: Validate API key
    API-->>CLI: Success + user info
```

### Dataset Upload (New Dataset)

```mermaid
sequenceDiagram
    participant U as User
    participant CLI as NEMAR CLI
    participant API as Backend
    participant GH as GitHub
    participant S3 as AWS S3

    U->>CLI: nemar dataset upload /path
    CLI->>CLI: Validate BIDS locally
    CLI->>GH: Verify gh CLI authentication
    CLI->>API: POST /datasets/create
    API->>API: Assign dataset ID (nm000XXX)
    API->>API: Create IAM credentials
    API->>GH: Create repo (Admin PAT)
    API->>GH: Add user as collaborator
    API-->>CLI: Dataset ID + presigned URLs
    CLI->>GH: Auto-accept invitation (gh API)
    CLI->>CLI: Wait for IAM propagation
    CLI->>S3: Upload data files (with retry)
    CLI->>GH: Commit with user identity
    CLI->>GH: Push via DataLad
    CLI-->>U: Success! URLs provided
```

**Note:** Branch protection is NOT applied during initial upload. Private datasets allow direct pushes to main. Protection is applied when creating a DOI (permanent record).

### Resume Failed Uploads

If an upload fails (network issues, S3 errors), you can resume:

```bash
# Just run upload again - CLI detects existing dataset
nemar dataset upload /path/to/dataset
```

The CLI stores dataset metadata in `.nemar/config.json` within your dataset directory. On resume:
1. Detects existing dataset ID from local config
2. Requests fresh presigned URLs from backend
3. Re-uploads files (git-annex handles duplicates)

To start fresh (new dataset ID), remove the config:
```bash
rm -rf /path/to/dataset/.nemar
```

### Pull Request Workflow (Contributing to Dataset)

```mermaid
sequenceDiagram
    participant C as Contributor
    participant CLI as NEMAR CLI
    participant API as Backend
    participant S3 as AWS S3
    participant GH as GitHub
    participant GA as GitHub Actions
    participant O as Dataset Owner

    C->>CLI: nemar dataset clone nm000104
    CLI->>GH: datalad clone
    CLI->>S3: datalad get (fetch data)

    Note over C: Make local changes

    C->>CLI: nemar dataset pr create
    CLI->>API: POST /pr/create
    API->>S3: Create staging area
    API-->>CLI: Presigned URLs
    CLI->>S3: Upload to staging/pr-XXX/
    CLI->>GH: Push branch + create PR

    GH->>GA: Trigger: PR opened
    GA->>S3: Fetch staged data
    GA->>GA: Run BIDS validation
    GA->>GH: Report status

    O->>GH: Review PR
    O->>GH: Approve & Merge

    GH->>GA: Trigger: PR merged
    GA->>S3: Copy staging → final
    GA->>S3: Delete staging
    GA->>GH: Post success comment
```

### PR Data Flow (S3 Staging)

```mermaid
graph LR
    subgraph "Before Merge"
        A[Local Files] -->|Upload| B[S3 staging/pr-XXX/]
        B -->|git-annex points to| C[PR Branch]
    end

    subgraph "After Merge"
        B -->|Copy| D[S3 nm000XXX/]
        D -->|git-annex points to| E[Main Branch]
        B -->|Delete| F[Cleaned Up]
    end
```

### Dataset Versioning & DOI

```mermaid
sequenceDiagram
    participant A as Admin
    participant CLI as NEMAR CLI
    participant API as Backend
    participant ZEN as Zenodo
    participant GH as GitHub

    Note over A: First release: Admin creates concept DOI
    A->>CLI: nemar admin doi create nm000104
    CLI->>API: POST /admin/doi/create
    API->>ZEN: Pre-reserve DOI
    API->>GH: Update dataset_description.json
    API->>GH: Create release tag
    API->>ZEN: Upload & publish
    API-->>A: Concept DOI: 10.5281/zenodo.XXX

    Note over A: Later: User creates version DOI
    participant U as User
    U->>CLI: nemar dataset version nm000104 v1.1.0
    CLI->>API: POST /datasets/version
    API->>ZEN: Create new version DOI
    API->>GH: Create release tag
    API-->>U: Version DOI created
```

## Commands

### Authentication

```bash
nemar auth signup              # Sign in with your browser; create or continue your account
nemar auth login               # Sign in with your browser (-k/--key to paste an existing key)
nemar auth status              # Check authentication status
nemar auth switch              # Switch between accounts
nemar auth logout              # Remove active account (--all for all)
nemar auth setup-ssh           # Configure SSH for GitHub
nemar auth keys                # List, create, or revoke this account's named API keys
```

### Dataset Management

```bash
nemar dataset validate <path>  # Validate BIDS dataset
nemar dataset upload <path>    # Upload new dataset
nemar dataset download <id>    # Download dataset (with data)
nemar dataset clone <id>       # Clone metadata only
nemar dataset get [files]      # Download annexed data files
nemar dataset drop [files]     # Free local copies of data
nemar dataset list             # List all datasets (--mine for own)
nemar dataset status <id>      # Check dataset status
nemar dataset release <id>     # Create version bump PR
nemar dataset update [path]    # Push local changes via PR
nemar dataset save             # Stage and commit changes
nemar dataset push             # Push commits and data
nemar dataset ci [id]          # Check BIDS validation CI status
nemar dataset manifest [ver]   # View version manifests
```

### Collaboration

```bash
nemar dataset request-access <id>          # Request collaborator access
nemar dataset invite <user> <id>           # Invite collaborator
nemar dataset collaborators <id>           # List collaborators
```

### Publication Workflow

```bash
# User: Request publication
nemar dataset publish request <dataset-id> # Submit publication request
nemar dataset publish status <dataset-id>  # Check publication status
nemar dataset publish resend <dataset-id>  # Resend admin notification

# Admin: Manage publication requests
nemar admin publish list                   # List all publication requests
nemar admin publish list --pending         # List pending requests only
nemar admin publish approve <dataset-id>   # Approve and publish dataset
nemar admin publish approve <dataset-id> --acknowledge-identifier-screen "<reason>"
                                           # Approve over a screen that needs review
nemar admin publish screen <dataset-id>    # Re-run the identifier screen
nemar admin publish deny <dataset-id>      # Deny publication request
```

A publication request is screened for identifying information before the
admins are mailed; the mail, `publish status` and `admin publish list` state
the result, and approval waits for a screen that is clear for the current
`main`.

### Admin Commands

```bash
# User management
nemar admin users                          # List all users
nemar admin users --pending                # List pending approvals
nemar admin approve <username>             # Approve user
nemar admin revoke <username>              # Revoke user access
nemar admin role <username> <role>         # Change user role

# Dataset management
nemar admin repo public <id>               # Make repo public
nemar admin repo private <id>              # Make repo private
nemar admin ci check <id>                  # Check CI status
nemar admin ci add <id>                    # Deploy CI workflows
nemar admin s3 regenerate-iam <user>       # Regenerate AWS credentials
nemar admin make-public <id>               # Publish dataset (permanent)
nemar admin delete-dataset <id>            # Delete dataset

# DOI management
nemar admin doi create <id>                # Create concept DOI
nemar admin doi info <id>                  # Get DOI info
nemar admin doi update <id>                # Update DOI metadata
nemar admin doi enrich <id>                # Enrich DOI metadata
```

## Access Control

| Role | Push Branches | Merge PRs | Delete Repos | Create DOI |
|------|--------------|-----------|--------------|------------|
| NEMAR User | All repos | Own datasets | No | Version DOI |
| Dataset Owner | All repos | Own datasets | No | Version DOI |
| Admin | All repos | All datasets | Yes | Concept DOI |

### Key Principles

1. **Private First**: New datasets are private; owners can push directly to main
2. **Protection on DOI**: Branch protection applied when creating a DOI (permanent record)
3. **PR-Based Updates**: After DOI creation, all changes require pull requests
4. **Collaborative**: Any NEMAR user can create PRs on any dataset
5. **Owner Approval**: Only dataset owner (or admin) can merge PRs
6. **No Deletion**: Users cannot delete repositories or S3 data
7. **Audit Trail**: All changes tracked via PR history

## Storage Architecture

```mermaid
graph TB
    subgraph "GitHub (nemarDatasets org)"
        META[Metadata + git history]
        REL[Releases + tags]
    end

    subgraph "AWS S3 (nemar bucket)"
        FINAL[nm000XXX/ - Published data]
        STAGE[staging/pr-XXX/ - PR data]
    end

    subgraph "Zenodo"
        DOI[DOIs + archived releases]
    end

    META ---|git-annex pointers| FINAL
    STAGE -->|On merge| FINAL
    REL -->|Archive| DOI
```

## Testing

### Running Tests

```bash
# All tests
bun test

# Specific test file
bun test test/cli.test.ts
bun test test/api.test.ts
```

### Zenodo Sandbox Tests

DOI workflows can be tested using Zenodo's sandbox environment without affecting production:

```bash
# Run Zenodo sandbox tests (requires configuration)
RUN_ZENODO_TESTS=true TEST_DATASET_ID=nm099999 bun test test/zenodo-sandbox.test.ts
```

**Setup requirements:**
1. Create account on [sandbox.zenodo.org](https://sandbox.zenodo.org)
2. Generate API token with `deposit:write` scope
3. Add to `test/.env.test`:
   ```bash
   ZENODO_SANDBOX_API_KEY=your_sandbox_token
   RUN_ZENODO_TESTS=true
   TEST_DATASET_ID=nm099999
   ```

**Test coverage:**
- Concept DOI creation and retrieval
- Version DOI publishing workflows
- Metadata updates (title, keywords, related identifiers)
- Error handling (401, 404, 400 responses)
- Rate limiting and request throttling
- Deposition lifecycle (create → upload → publish)
- File uploads with checksum verification

See [the Zenodo testing guide](https://docs.nemar.org/develop/zenodo-testing/) for a comprehensive walkthrough.

## Environment Variables

### CLI Usage

```bash
NEMAR_API_KEY          # API key (alternative to `nemar auth login -k`)
NEMAR_NO_BROWSER=1     # Never try to open a browser during sign-in (same as --no-open)
NEMAR_NO_COLOR         # Disable colored output
```

### Testing

```bash
# Required for Zenodo sandbox tests
ZENODO_SANDBOX_API_KEY # Sandbox Zenodo API token
RUN_ZENODO_TESTS       # Enable Zenodo tests (set to "true")
TEST_DATASET_ID        # Test dataset ID (default: nm099999)

# API testing
TEST_API_URL           # Test API endpoint (dev environment)
TEST_ADMIN_API_KEY     # Admin API key for tests
TEST_USER_API_KEY      # User API key for tests
```

## Troubleshooting

### Upload Issues

**"GitHub CLI not authenticated" or "gh CLI username mismatch"**
```bash
# Login to GitHub CLI with your NEMAR account
gh auth login
# Verify the authenticated username matches your NEMAR username
gh auth status
```
The CLI verifies `gh` is authenticated as your NEMAR user to prevent permission issues.

**"S3 upload failed" or "AccessDenied (403)"**
- AWS IAM policy changes take 10-30 seconds to propagate globally
- The CLI has built-in retry logic (4 retries with progressive delays)
- If retries fail, wait 30 seconds and run upload again
- Admin users don't hit this issue (full bucket access)

**"Failed to accept GitHub invitation"**
- The CLI auto-accepts repo invitations, but `gh` must be authenticated as the invited user
- Manually accept at: https://github.com/nemarDatasets/[dataset-id]/invitations
- Then re-run the upload command

**"Failed to push to GitHub"**
- Check SSH configuration for multiple GitHub accounts
- If you have multiple GitHub accounts, configure SSH host aliases:
  ```bash
  # ~/.ssh/config
  Host github-nemar
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_nemar
  ```
- See `nemar auth status` for SSH setup instructions

**"Dataset already exists" / Resume Upload**
- The CLI stores dataset metadata in `.nemar/config.json`
- To **resume**: just run `nemar dataset upload` again
- To **start fresh** with new dataset ID: `rm -rf /path/to/dataset/.nemar`

**Upload completes but commits show wrong author**
- Commits use your NEMAR user identity (username and registered email)
- Ensure your NEMAR account has correct email registered
- Check with `nemar auth status`

### Authentication Issues

**"API key invalid"**
```bash
nemar auth logout
nemar auth login
```

**Browser doesn't open, or you're on a headless/remote host**
- The printed link is the real mechanism, not the browser: copy it into any
  browser, on any machine, and authorize there
- `nemar auth login --no-open` (or `NEMAR_NO_BROWSER=1`) skips the attempt
  entirely and just prints the link
- If nothing can open a browser at all, paste an existing key instead:
  `nemar auth login -k <api-key>` (create one with `nemar auth keys create`
  on a machine that can)

**Upload access is not granted yet**
- Upload access is a separate, one-time admin approval requested with
  `nemar auth request-upload-access` (or automatically at the end of
  `nemar auth signup`)
- Browsing, downloading, and sandbox training all work without it
- Contact your NEMAR administrator if the request has been pending a while

### Branch Protection

**"Cannot push directly to main"**
- If your dataset has a DOI, branch protection is enabled
- All changes require pull requests after DOI creation
- Private datasets without DOI allow direct pushes

**"Branch protection not applied after upload"**
- This is expected for new private datasets
- Protection is applied when admin creates a DOI (`nemar admin doi create`)
- Allows owners to freely modify their private workspace

## Development

```bash
# Clone repository
git clone https://github.com/nemarOrg/nemar-cli.git
cd nemar-cli

# Install dependencies
bun install

# Run in development
bun run dev

# Run tests
bun test

# Lint
bun run lint

# Build
bun run build
```

## Related Projects

- [NEMAR](https://nemar.org) - Neuroelectromagnetic Data Archive
- [OpenNeuro](https://openneuro.org) - Open platform for neuroimaging data
- [BIDS](https://bids.neuroimaging.io) - Brain Imaging Data Structure
- [DataLad](https://www.datalad.org) - Distributed data management
- [BIDS Validator](https://github.com/bids-standard/bids-validator) - BIDS validation tool

## Community and Policies

- [NEMAR policies](https://docs.nemar.org/policies/) - privacy policy, data contributor terms, GDPR position statement, takedown procedure
- [Code of Conduct](https://github.com/nemarOrg/.github/blob/main/CODE_OF_CONDUCT.md), [Contributing](https://github.com/nemarOrg/.github/blob/main/CONTRIBUTING.md), and [Security policy](https://github.com/nemarOrg/.github/blob/main/SECURITY.md) apply org-wide from [nemarOrg/.github](https://github.com/nemarOrg/.github).
- Help using NEMAR: support@nemar.org. Bugs and feature requests: open an issue on this repository.

## License

This project is licensed under the [Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International License](https://creativecommons.org/licenses/by-nc-nd/4.0/).

You are free to share (copy and redistribute) the material for non-commercial purposes, with appropriate attribution. No derivatives or adaptations are permitted.
