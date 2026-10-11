#!/bin/bash
################################################################################
# NEMAR Dataset Restoration Script
#
# Purpose: Restore NEMAR datasets from Zenodo archives to GitHub repositories
#          with git-annex configuration for S3-backed data files.
#
# Author: NEMAR Development Team
# Date: 2026-01-18
# Version: 1.0.0
#
# Usage:
#   # Set up ~/.aws/credentials (mode 0600) with a long-lived AKIA key, OR
#   # run `aws sso login` for a short-lived session, then:
#   ./nemar-restore-dataset.sh <dataset_id> <version> <name> <zenodo_doi> <datalad_id>
#
# Example:
#   ./nemar-restore-dataset.sh nm000105 v1.1.0 "discrete_gestures" \
#     10.5281/zenodo.17613958 f9028a54-3d7e-4af0-994f-19dc40de6a0a
#
# Requirements:
#   - git, git-annex, gh CLI, unzip, curl
#   - AWS credentials resolvable via the AWS default chain
#     (~/.aws/credentials, or aws sso login). Long-lived keys in env
#     vars are rejected; see https://docs.nemar.org/admin/operations/access-policies/.
#   - GitHub authentication via gh CLI
#   - Zenodo archive downloaded to ARCHIVE_DIR
#   - SSH access to GitHub (via multi-account SSH config)
#
# Process Overview:
#   1. Extract Zenodo archive
#   2. Initialize git repository
#   3. Initialize git-annex with largefiles config
#   4. Add files (data → annex, metadata → git)
#   5. Commit with restoration metadata
#   6. Register S3 URLs for annexed files
#   7. Create GitHub repository
#   8. Push to GitHub (main + git-annex branches)
#   9. Verify restoration
#
# Exit Codes:
#   0 - Success
#   1 - General error
#   2 - Missing prerequisites
#   3 - Extraction failed
#   4 - Git operation failed
#   5 - GitHub operation failed
################################################################################

set -euo pipefail  # Exit on error, undefined vars, pipe failures

################################################################################
# Configuration
################################################################################

# Directories
ARCHIVE_DIR="${ARCHIVE_DIR:-/tmp/restore}"
WORK_BASE_DIR="${WORK_BASE_DIR:-${ARCHIVE_DIR}/restore_work}"

# GitHub organization and SSH configuration
GITHUB_ORG="${GITHUB_ORG:-nemarDatasets}"
SSH_HOST="${SSH_HOST:-github.com}"

# Git committer identity (NEMAR Restore Agent)
GIT_COMMITTER_NAME="NEMAR Restore"
GIT_COMMITTER_EMAIL="nemarRestore@osc.earth"

# S3 configuration
S3_BUCKET="nemar"
S3_REGION="us-east-2"
S3_BASE_URL="https://nemar.s3.${S3_REGION}.amazonaws.com"

# Git-annex largefiles configuration.
# Annex data files by extension or size, but NEVER annex metadata (TSV, JSON,
# MD, txt, etc.) - they must stay in git for BIDS validation. tsv.gz IS annexed,
# and so is *_motion.tsv, which is a recording despite the .tsv extension.
#
# MUST match buildLargefilesExpression() in src/lib/git-annex/policy.ts, which is
# the single source of truth. test/annex-policy.test.ts parses this exact line
# and fails if the two drift apart -- shell cannot import the TS, so the test is
# the only thing holding them together. Regenerate with:
#   bun -e 'import {buildLargefilesExpression} from "./src/lib/git-annex/policy.ts"; console.log(buildLargefilesExpression())'
ANNEX_LARGEFILES="(include=*.edf or include=*.bdf or include=*.set or include=*.fif or include=*.vhdr or include=*.eeg or include=*.cnt or include=*.fdt or include=*_motion.tsv or largerthan=100000) and (exclude=*.tsv or include=*_motion.tsv) and exclude=*.json and exclude=*.md and exclude=*.txt and exclude=*.yml and exclude=*.yaml and exclude=README* and exclude=LICENSE* and exclude=CHANGES* and exclude=.bidsignore and exclude=.gitignore"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

################################################################################
# Helper Functions
################################################################################

# Print colored status messages
log_info() {
    echo -e "${BLUE}[INFO]${NC} $*"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $*"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $*"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $*" >&2
}

# Print step header
print_step() {
    local step_num=$1
    local total_steps=$2
    local description=$3
    echo
    echo "============================================================"
    echo "[Step ${step_num}/${total_steps}] ${description}"
    echo "============================================================"
}

# Check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

################################################################################
# Cleanup Handler
################################################################################

# Global variable to track if GitHub repo was created
CREATED_GITHUB_REPO=""

# Cleanup function called on error
cleanup_on_failure() {
    local exit_code=$?

    # Only cleanup if script failed (non-zero exit) and repo was created
    if [ $exit_code -ne 0 ] && [ -n "$CREATED_GITHUB_REPO" ]; then
        log_warning "Script failed with exit code ${exit_code}"
        log_warning "Cleaning up partially created GitHub repository..."

        # Attempt to delete the GitHub repository
        if gh repo delete "${GITHUB_ORG}/${CREATED_GITHUB_REPO}" --yes 2>/dev/null; then
            log_info "Cleaned up repository: ${GITHUB_ORG}/${CREATED_GITHUB_REPO}"
        else
            log_warning "Could not automatically delete repository: ${GITHUB_ORG}/${CREATED_GITHUB_REPO}"
            log_warning "Manual cleanup may be required"
        fi

        CREATED_GITHUB_REPO=""
    fi
}

# Set trap to call cleanup on script exit
trap cleanup_on_failure EXIT

################################################################################
# Prerequisites Check
################################################################################

# Verify prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."

    local missing_deps=()

    for cmd in git git-annex gh unzip curl; do
        if ! command_exists "$cmd"; then
            missing_deps+=("$cmd")
        fi
    done

    if [ ${#missing_deps[@]} -gt 0 ]; then
        log_error "Missing required commands: ${missing_deps[*]}"
        log_error "Please install missing dependencies and try again"
        return 2
    fi

    # Check AWS credentials via shared guard. Rejects long-lived AKIA*
    # keys in env (security: env vars leak to child processes), requires
    # either ~/.aws/credentials (mode 0600) or short-lived ASIA* from
    # `aws sso login` / `aws-vault`. See https://docs.nemar.org/admin/operations/access-policies/
    # (principles 5 + 6).
    # shellcheck source=lib/aws-creds-guard.sh
    . "$(dirname "${BASH_SOURCE[0]}")/lib/aws-creds-guard.sh"
    if ! nemar_guard_aws_credentials; then
        return 2
    fi

    # Check gh authentication
    if ! gh auth status >/dev/null 2>&1; then
        log_error "GitHub CLI (gh) not authenticated"
        log_error "Please run: gh auth login"
        return 2
    fi

    log_success "All prerequisites satisfied"
    return 0
}

################################################################################
# Main Restoration Function
################################################################################

restore_dataset() {
    local dataset_id=$1
    local version=$2
    local dataset_name=$3
    local zenodo_doi=$4
    local datalad_id=$5

    # ========================================================================
    # INPUT VALIDATION (Security: Prevent command injection and bad inputs)
    # ========================================================================

    # Validate dataset_id format (nmXXXXXX)
    if [[ ! "$dataset_id" =~ ^nm[0-9]{6}$ ]]; then
        log_error "Invalid dataset_id format: '$dataset_id'"
        log_error "Expected format: nmXXXXXX (e.g., nm000105)"
        return 1
    fi

    # Validate version format (vX.X.X)
    if [[ ! "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9]+)?$ ]]; then
        log_error "Invalid version format: '$version'"
        log_error "Expected format: vX.X.X (e.g., v1.0.0 or v1.0.0-beta)"
        return 1
    fi

    # Validate dataset_name (no shell metacharacters)
    if [[ "$dataset_name" =~ [\;\&\|\$\`\(\)\\] ]]; then
        log_error "Invalid dataset_name: '$dataset_name'"
        log_error "Dataset name cannot contain shell metacharacters: ; & | \$ \` ( ) \\"
        return 1
    fi

    # Validate Zenodo DOI format (10.5281/zenodo.XXXXXXX)
    if [[ ! "$zenodo_doi" =~ ^10\.5281/zenodo\.[0-9]+$ ]]; then
        log_error "Invalid Zenodo DOI format: '$zenodo_doi'"
        log_error "Expected format: 10.5281/zenodo.XXXXXXX"
        return 1
    fi

    # Validate DataLad ID (UUID format)
    if [[ ! "$datalad_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
        log_error "Invalid DataLad ID format: '$datalad_id'"
        log_error "Expected format: UUID (e.g., f9028a54-3d7e-4af0-994f-19dc40de6a0a)"
        return 1
    fi

    log_info "Input validation passed"

    # Derived variables
    local work_dir="${WORK_BASE_DIR}/${dataset_id}"
    local archive_file="${ARCHIVE_DIR}/${dataset_id}-${version}.zip"
    local extracted_version="${version#v}"  # Remove 'v' prefix
    local dataset_dir="${work_dir}/${dataset_id}-${extracted_version}"

    # Print restoration header
    echo
    echo "################################################################"
    echo "# NEMAR Dataset Restoration"
    echo "################################################################"
    echo "Dataset ID:       ${dataset_id}"
    echo "Version:          ${version}"
    echo "Name:             ${dataset_name}"
    echo "Zenodo DOI:       ${zenodo_doi}"
    echo "DataLad ID:       ${datalad_id}"
    echo "Archive:          ${archive_file}"
    echo "Work Directory:   ${dataset_dir}"
    echo "GitHub Repo:      ${GITHUB_ORG}/${dataset_id}"
    echo "################################################################"
    echo

    # Check prerequisites
    check_prerequisites || return $?

    # Verify archive exists
    if [ ! -f "$archive_file" ]; then
        log_error "Archive file not found: ${archive_file}"
        return 1
    fi

    #---------------------------------------------------------------------------
    # Step 1: Extract Zenodo Archive
    #---------------------------------------------------------------------------
    print_step 1 13 "Extracting Zenodo Archive"

    # Clean up existing work directory
    if [ -d "$work_dir" ]; then
        log_info "Removing existing work directory..."
        chmod -R +w "$work_dir" 2>/dev/null || true
        rm -rf "$work_dir"
    fi

    mkdir -p "$work_dir"
    cd "$work_dir"

    log_info "Extracting ${archive_file}..."
    if ! unzip -q "${archive_file}"; then
        log_error "Failed to extract archive"
        return 3
    fi

    # Verify extraction
    if [ ! -d "$dataset_dir" ]; then
        log_error "Extraction failed: ${dataset_dir} not found"
        return 3
    fi

    cd "$dataset_dir"

    # Verify BIDS dataset
    if [ ! -f "dataset_description.json" ]; then
        log_error "Not a valid BIDS dataset: dataset_description.json not found"
        return 3
    fi

    log_success "Extracted to ${dataset_dir}"

    #---------------------------------------------------------------------------
    # Step 2: Initialize Git Repository
    #---------------------------------------------------------------------------
    print_step 2 13 "Initializing Git Repository"

    if ! git init; then
        log_error "Failed to initialize git repository"
        return 4
    fi

    # Configure git committer identity
    git config user.name "$GIT_COMMITTER_NAME"
    git config user.email "$GIT_COMMITTER_EMAIL"

    log_success "Git repository initialized"
    log_info "Committer: ${GIT_COMMITTER_NAME} <${GIT_COMMITTER_EMAIL}>"

    #---------------------------------------------------------------------------
    # Step 3: Initialize Git-Annex
    #---------------------------------------------------------------------------
    print_step 3 13 "Initializing Git-Annex"

    local annex_description="${dataset_id}-restored"
    if ! git annex init "$annex_description"; then
        log_error "Failed to initialize git-annex"
        return 4
    fi

    # Get the UUID for logging
    local annex_uuid
    annex_uuid=$(git config annex.uuid)

    log_success "Git-annex initialized"
    log_info "Description: ${annex_description}"
    log_info "UUID: ${annex_uuid}"

    #---------------------------------------------------------------------------
    # Step 4: Configure Annex Large Files
    #---------------------------------------------------------------------------
    print_step 4 13 "Configuring Git-Annex Large Files Policy"

    log_info "Configuring annex.largefiles..."
    log_info "Policy: ${ANNEX_LARGEFILES}"

    if ! git annex config --set annex.largefiles "$ANNEX_LARGEFILES"; then
        log_error "Failed to configure annex.largefiles"
        return 4
    fi

    log_success "Git-annex will ONLY annex data files (.edf, .bdf, .set)"
    log_info "Metadata files (README, JSON, TSV, etc.) will go to regular git"

    #---------------------------------------------------------------------------
    # Step 5: Add Files to Repository
    #---------------------------------------------------------------------------
    print_step 5 13 "Adding Files to Repository"

    log_info "Running git annex add (respects largefiles config)..."
    if ! git annex add . 2>&1 | grep -E "(ok|add)" | tail -10; then
        log_error "Failed to add files"
        return 4
    fi

    log_success "Files added to repository"

    # Show statistics
    local total_files
    local annexed_files
    total_files=$(git ls-files | wc -l | tr -d ' ')
    annexed_files=$(git annex find | wc -l | tr -d ' ')

    log_info "Total files: ${total_files}"
    log_info "Annexed files: ${annexed_files}"
    log_info "Regular git files: $((total_files - annexed_files))"

    #---------------------------------------------------------------------------
    # Step 6: Create Initial Commit
    #---------------------------------------------------------------------------
    print_step 6 13 "Creating Initial Commit"

    local commit_message="Restore ${dataset_id} from Zenodo archive

Dataset: ${dataset_name} ${version}
Zenodo DOI: ${zenodo_doi}
DataLad ID: ${datalad_id}
S3 Location: s3://${S3_BUCKET}/${dataset_id}/

Restoration Details:
- Restored from Zenodo preservation archive
- Original git history was not preserved in archive
- Started with fresh commit history
- Original git-annex UUID lost, new UUID generated
- DataLad dataset ID preserved from archive
- S3 data files remain intact at original location

Restoration Process:
- Git-annex configured to only annex data files (.edf, .bdf, .set)
- Metadata files (README, JSON, TSV) stored in regular git
- S3 URLs registered for all annexed files
- Data accessible via: ${S3_BASE_URL}/${dataset_id}/

Restored by: ${GIT_COMMITTER_NAME}
Date: $(date -u +"%Y-%m-%d %H:%M:%S UTC")"

    if ! git commit -m "$commit_message"; then
        log_error "Failed to create commit"
        return 4
    fi

    local commit_hash
    commit_hash=$(git rev-parse HEAD)

    log_success "Initial commit created"
    log_info "Commit: ${commit_hash:0:8}"

    #---------------------------------------------------------------------------
    # Step 7: Register S3 URLs for Annexed Files
    #---------------------------------------------------------------------------
    print_step 7 13 "Registering S3 URLs for Annexed Files"

    log_info "Registering S3 URLs for data files..."
    log_info "This tells git-annex where to download files from S3"

    local registered_count=0

    # Register URLs for all annexed data files
    # Use process substitution to avoid subshell variable scope issue
    while read -r file; do
        local key
        key=$(git annex lookupkey "$file")
        if [ -n "$key" ]; then
            if git annex registerurl "$key" "${S3_BASE_URL}/${dataset_id}/$key" >/dev/null 2>&1; then
                ((registered_count++)) || true
            fi
        fi
    done < <(git annex find --include='*.bdf' --include='*.edf' --include='*.set')

    log_success "S3 URLs registered for ${registered_count} annexed files"

    #---------------------------------------------------------------------------
    # Step 8: Verify S3 URL Registration
    #---------------------------------------------------------------------------
    print_step 8 13 "Verifying S3 URL Registration"

    # Get count of annexed data files
    local data_file_count
    data_file_count=$(git annex find --include='*.bdf' --include='*.edf' --include='*.set' | wc -l | tr -d ' ')

    log_info "Total annexed data files: ${data_file_count}"

    # Test a sample file
    local sample_file
    sample_file=$(git annex find --include='*.bdf' --include='*.edf' --include='*.set' | head -1)

    if [ -n "$sample_file" ]; then
        log_info "Sample file: ${sample_file}"
        if git annex whereis "$sample_file" | grep -q "web:"; then
            log_success "S3 URL registration verified"
        else
            log_warning "Could not verify S3 URL for sample file"
        fi
    fi

    #---------------------------------------------------------------------------
    # Step 9: Verify Metadata Files in Git
    #---------------------------------------------------------------------------
    print_step 9 13 "Verifying Metadata Files in Git"

    log_info "Checking that metadata files are in regular git (not annexed)..."

    local metadata_files=("README.md" "dataset_description.json" "participants.json")
    local all_correct=true

    for file in "${metadata_files[@]}"; do
        if [ -f "$file" ]; then
            # Check if file is annexed (pointer file)
            if git show "HEAD:$file" | head -1 | grep -q "^/annex/objects/"; then
                log_error "${file} is annexed (should be in regular git)"
                all_correct=false
            else
                log_success "${file} is in regular git ✓"
            fi
        fi
    done

    if [ "$all_correct" = false ]; then
        log_error "Some metadata files are incorrectly annexed"
        return 4
    fi

    #---------------------------------------------------------------------------
    # Step 10: Create GitHub Repository
    #---------------------------------------------------------------------------
    print_step 10 13 "Creating GitHub Repository"

    log_info "Creating repository: ${GITHUB_ORG}/${dataset_id}"

    if gh repo create "${GITHUB_ORG}/${dataset_id}" \
        --private \
        --description "NEMAR Dataset ${dataset_id}: ${dataset_name} (Restored from Zenodo)" 2>&1; then
        log_success "GitHub repository created"
        # Track repo for cleanup if later steps fail
        CREATED_GITHUB_REPO="${dataset_id}"
    else
        log_warning "Repository may already exist"
        # If repo already exists, don't track for cleanup
    fi

    #---------------------------------------------------------------------------
    # Step 11: Configure GitHub Remote
    #---------------------------------------------------------------------------
    print_step 11 13 "Configuring GitHub Remote"

    local remote_url="git@${SSH_HOST}:${GITHUB_ORG}/${dataset_id}.git"

    log_info "Setting remote: ${remote_url}"

    if git remote add origin "$remote_url" 2>/dev/null; then
        log_success "GitHub remote added"
    else
        git remote set-url origin "$remote_url"
        log_success "GitHub remote updated"
    fi

    #---------------------------------------------------------------------------
    # Step 12: Push to GitHub
    #---------------------------------------------------------------------------
    print_step 12 13 "Pushing to GitHub"

    # Detect current branch name
    local branch_name
    branch_name=$(git branch --show-current)
    log_info "Pushing ${branch_name} branch..."

    if git push -u origin "${branch_name}" 2>&1; then
        log_success "${branch_name} branch pushed"
    else
        log_error "Failed to push ${branch_name} branch"
        return 5
    fi

    log_info "Pushing git-annex branch..."
    if git push origin git-annex 2>&1; then
        log_success "Git-annex branch pushed"
    else
        log_error "Failed to push git-annex branch"
        return 5
    fi

    #---------------------------------------------------------------------------
    # Step 13: Final Verification
    #---------------------------------------------------------------------------
    print_step 13 13 "Final Verification"

    log_info "Verifying repository on GitHub..."

    local repo_info
    if repo_info=$(gh repo view "${GITHUB_ORG}/${dataset_id}" --json url,description,isPrivate 2>&1); then
        local repo_url
        repo_url=$(echo "$repo_info" | grep -o 'https://github.com/[^"]*')
        log_success "Repository verified: ${repo_url}"
    else
        log_error "Failed to verify repository on GitHub"
        return 5
    fi

    # Verify both branches are on GitHub
    if git ls-remote origin | grep -q "refs/heads/git-annex"; then
        log_success "Git-annex branch verified on GitHub"
    else
        log_warning "Git-annex branch not found on GitHub"
    fi

    #---------------------------------------------------------------------------
    # Restoration Complete
    #---------------------------------------------------------------------------
    echo
    echo "################################################################"
    echo "# ✅ RESTORATION COMPLETE"
    echo "################################################################"
    echo "Dataset:          ${dataset_id}"
    echo "Version:          ${version}"
    echo "GitHub:           https://github.com/${GITHUB_ORG}/${dataset_id}"
    echo "Work Directory:   ${dataset_dir}"
    echo "Annexed Files:    ${annexed_files}"
    echo "Total Files:      ${total_files}"
    echo "################################################################"
    echo

    # Clear cleanup tracking (restoration succeeded)
    CREATED_GITHUB_REPO=""

    return 0
}

################################################################################
# Script Entry Point
################################################################################

main() {
    # Check argument count
    if [ $# -ne 5 ]; then
        echo "Usage: $0 <dataset_id> <version> <name> <zenodo_doi> <datalad_id>"
        echo
        echo "Example:"
        echo "  $0 nm000105 v1.1.0 \"discrete_gestures\" \\"
        echo "    10.5281/zenodo.17613958 f9028a54-3d7e-4af0-994f-19dc40de6a0a"
        echo
        echo "Environment variables:"
        echo "  ARCHIVE_DIR               - Directory with Zenodo archives (default: /tmp/restore)"
        echo
        echo "AWS credentials:"
        echo "  Place a long-lived AKIA* key in ~/.aws/credentials (mode 0600), OR"
        echo "  use a short-lived ASIA* session via 'aws sso login' / 'aws-vault'."
        echo "  Long-lived keys in process env vars are REJECTED by the credentials"
        echo "  guard. See https://docs.nemar.org/admin/operations/access-policies/ (principles 5 + 6)."
        echo "  WORK_BASE_DIR             - Working directory (default: \$ARCHIVE_DIR/restore_work)"
        echo "  GITHUB_ORG                - GitHub organization (default: nemarDatasets)"
        echo "  SSH_HOST                  - SSH host for GitHub (default: github.com)"
        echo "                              Set to custom SSH alias if using multi-account SSH config"
        return 1
    fi

    # Run restoration
    restore_dataset "$@"
}

# Run main function with all arguments
main "$@"
