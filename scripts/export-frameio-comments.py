import os
import json
import time
from datetime import datetime, timedelta, timezone
import requests

# Load required env vars
FRAMEIO_TOKEN = os.getenv("FRAMEIO_TOKEN")
FRAMEIO_ACCOUNT_ID = os.getenv("FRAMEIO_ACCOUNT_ID")

if not FRAMEIO_TOKEN:
    raise SystemExit("FRAMEIO_TOKEN is required")

# Define projects to scan. Update as needed or parse from env/JSON
PROJECT_CONFIGS = [
    {
        "project_id": os.getenv("FRAMEIO_PROJECT_ID"),
        "root_asset_id": os.getenv("FRAMEIO_ROOT_ASSET_ID")
    }
]

BASE_URL = "https://api.frame.io/v2"
APP_BASE_URL = "https://app.frame.io"
HEADERS = {
    "Authorization": f"Bearer {FRAMEIO_TOKEN}",
    "Content-Type": "application/json"
}

TIME_THRESHOLD = datetime.now(timezone.utc) - timedelta(days=30)

def fetch_paginated_data(url):
    items = []
    while url:
        try:
            res = requests.get(url, headers=HEADERS)
            res.raise_for_status()
            data = res.json()
            if isinstance(data, dict):
                items.extend(data.get("data", []))
                url = data.get("links", {}).get("next")
            elif isinstance(data, list):
                items.extend(data)
                url = None
            else:
                print(f"Warning: unexpected data type {type(data)} from {url}")
                url = None
            time.sleep(0.5)
        except requests.RequestException as e:
            print(f"Error fetching {url}: {e}")
            url = None
    return items

def get_all_recent_files(root_asset_id):
    recent = []
    queue = [root_asset_id]
    while queue:
        current = queue.pop(0)
        for item in fetch_paginated_data(f"{BASE_URL}/assets/{current}/children"):
            itype = item.get("_type")
            if itype == "file":
                upd = item.get("updated_at")
                if upd:
                    try:
                        updated_at = datetime.fromisoformat(upd.replace('Z','+00:00'))
                        if updated_at >= TIME_THRESHOLD:
                            recent.append(item)
                    except ValueError:
                        recent.append(item)
                else:
                    recent.append(item)
            elif itype in ("folder", "version_stack"):
                queue.append(item.get("id"))
    return recent

def get_comments(asset_id):
    return fetch_paginated_data(f"{BASE_URL}/assets/{asset_id}/comments")

def main():
    all_comments = []
    for cfg in PROJECT_CONFIGS:
        pid = cfg.get("project_id")
        root = cfg.get("root_asset_id")
        if not pid or not root:
            continue
        print(f"Processing project {pid}")
        files = get_all_recent_files(root)
        for f in files:
            comments = get_comments(f['id'])
            link = f"{APP_BASE_URL}/player/{f['id']}"
            for c in comments:
                ts = c.get('inserted_at')
                if ts:
                    try:
                        inserted = datetime.fromisoformat(ts.replace('Z','+00:00'))
                    except ValueError:
                        continue
                    if inserted < TIME_THRESHOLD:
                        continue
                all_comments.append({
                    'project_id': pid,
                    'file_name': f['name'],
                    'file_link': link,
                    'comment_text': c.get('text', ''),
                    'comment_timestamp': ts
                })
    if all_comments:
        with open('frameio_recent_comments.json','w',encoding='utf-8') as f:
            json.dump(all_comments,f,indent=4,ensure_ascii=False)
        print(f"Exported {len(all_comments)} comments to frameio_recent_comments.json")
    else:
        print("No recent comments found")

if __name__ == '__main__':
    main()
