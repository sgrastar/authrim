#!/bin/bash

# Authrim Worker Deployment Monitor
# Monitors Cloudflare Worker deployments with auto-refresh and manual controls

set -e

# Parse arguments
DEPLOY_ENV=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --env=*)
            DEPLOY_ENV="${1#*=}"
            shift
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 --env=<environment>"
            exit 1
            ;;
    esac
done

# Validate environment is provided
if [ -z "$DEPLOY_ENV" ]; then
    echo "Error: --env flag is required"
    echo "Usage: $0 --env=<environment>"
    echo "Example: $0 --env=conformance"
    exit 1
fi

# Workers to monitor
WORKERS=(
    "op-async"
    "op-auth"
    "op-discovery"
    "op-management"
    "op-token"
    "op-userinfo"
    "external-idp"
    "shared"
    "router"
)

# Auto-refresh interval (10 minutes = 600 seconds)
REFRESH_INTERVAL=600

# Terminal setup
setup_terminal() {
    # Save terminal settings
    SAVED_STTY=$(stty -g)

    # Set terminal to raw mode for key detection
    stty -echo -icanon time 0 min 0

    # Hide cursor
    tput civis

    # Clear screen
    clear
}

# Terminal cleanup
cleanup_terminal() {
    # Restore terminal settings
    stty "$SAVED_STTY"

    # Show cursor
    tput cnorm

    # Clear screen
    clear

    echo "Monitor stopped."
}

# Trap exit to cleanup
trap cleanup_terminal EXIT INT TERM

# Fetch deployment info for a worker
get_deployment_info() {
    local worker_name=$1
    local full_name="${DEPLOY_ENV}-authrim-${worker_name}"

    # Run wrangler deployments list and capture full output
    local output=$(wrangler deployments list --name "$full_name" 2>/dev/null | head -20 || echo "")

    if [ -z "$output" ]; then
        echo "N/A|N/A|$full_name"
        return
    fi

    # Get the Version(s): section
    local version_section=$(echo "$output" | grep -A 3 "Version(s):" || echo "")

    if [ -z "$version_section" ]; then
        echo "N/A|N/A|$full_name"
        return
    fi

    # Extract version ID from the "Version(s):" line itself
    # Example line: "Version(s):  (100%) 20d227d8-d557-4656-bfda-4550d35c9daf"
    # We want the UUID which is the 3rd field (after "Version(s):" and "(100%)")
    local version_id=$(echo "$version_section" | grep "Version(s):" | awk '{print $3}' | head -1)

    if [ -z "$version_id" ] || [ "$version_id" = "-" ]; then
        version_id="N/A"
    fi

    # Extract created date from the indented "Created:" line within the version section
    # Example line: "                     Created:  2025-11-23T02:43:15.948Z"
    # We need to skip the first "Created:" (from the top of output) and get the one inside Version section
    local created_date=$(echo "$version_section" | grep "Created:" | tail -1 | sed 's/.*Created:[[:space:]]*//' | awk '{print $1}')

    if [ -z "$created_date" ]; then
        created_date="N/A"
    fi

    echo "${version_id}|${created_date}|${full_name}"
}

# Fetch all deployment data (stores result in global DEPLOYMENT_DATA array)
fetch_all_deployments() {
    # Clear global array
    DEPLOYMENT_DATA=()

    # Fetch data for all workers
    for worker in "${WORKERS[@]}"; do
        local info=$(get_deployment_info "$worker")
        DEPLOYMENT_DATA+=("$info")
    done
}

# Display deployment information
display_deployments() {
    local last_update=$1
    local next_refresh=$2
    shift 2
    local deployment_data=("$@")

    # Move cursor to top
    tput cup 0 0

    # Clear from cursor to end of screen
    tput ed

    # Header
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Authrim Worker Deployment Monitor"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "  Environment: ${DEPLOY_ENV}"
    echo "  最終取得: ${last_update}"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    printf "  %-38s %-26s %-40s\n" "VERSION ID" "CREATED" "WORKER"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # Display each worker's data
    for info in "${deployment_data[@]}"; do
        local version_id=$(echo "$info" | cut -d'|' -f1)
        local created=$(echo "$info" | cut -d'|' -f2)
        local worker_name=$(echo "$info" | cut -d'|' -f3)

        printf "  %-38s %-26s %-40s\n" "$version_id" "$created" "$worker_name"
    done

    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "  [q]終了  [r]更新  (次回自動更新: ${next_refresh})"
    echo ""
}

# Format seconds to human readable time
format_time_remaining() {
    local seconds=$1
    local minutes=$((seconds / 60))
    local secs=$((seconds % 60))

    if [ $minutes -gt 0 ]; then
        echo "${minutes}分${secs}秒後"
    else
        echo "${secs}秒後"
    fi
}

# Global array for deployment data (used instead of nameref for bash 3.x compatibility)
DEPLOYMENT_DATA=()

# Main loop
main() {
    setup_terminal

    local last_refresh_time=0
    local force_refresh=1
    local last_update=""

    while true; do
        local current_time=$(date +%s)
        local time_since_refresh=$((current_time - last_refresh_time))

        # Check if we need to refresh (auto or manual)
        if [ $force_refresh -eq 1 ] || [ $time_since_refresh -ge $REFRESH_INTERVAL ]; then
            # Fetch all deployment data (stores in global DEPLOYMENT_DATA)
            fetch_all_deployments

            last_update=$(date '+%Y-%m-%d %H:%M:%S')
            last_refresh_time=$current_time
            force_refresh=0

            # Calculate next refresh time
            local time_until_refresh=$REFRESH_INTERVAL
        else
            local time_until_refresh=$((REFRESH_INTERVAL - time_since_refresh))
        fi

        # Display current information
        local next_refresh_str=$(format_time_remaining $time_until_refresh)
        display_deployments "$last_update" "$next_refresh_str" "${DEPLOYMENT_DATA[@]}"

        # Check for key press (non-blocking)
        local key=""
        read -t 1 -n 1 key 2>/dev/null || true

        case "$key" in
            q|Q)
                # Quit
                exit 0
                ;;
            r|R)
                # Force refresh
                force_refresh=1
                ;;
        esac

        # Small delay before next iteration
        sleep 1
    done
}

# Run main loop
main
