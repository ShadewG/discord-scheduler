import os
import json
import time
from datetime import datetime, timedelta, timezone
import requests

# Configuration via environment variables
FRAMEIO_TOKEN = os.getenv('FRAMEIO_TOKEN')
FRAMEIO_ACCOUNT_ID = os.getenv('FRAMEIO_ACCOUNT_ID')
FRAMEIO_ROOT_ASSET_ID = os.getenv('FRAMEIO_ROOT_ASSET_ID')

BASE_URL = "https://api.frame.io/v2"
APP_BASE_URL = "https://app.frame.io"

HEADERS = {
    "Authorization": f"Bearer {FRAMEIO_TOKEN}",
    "Content-Type": "application/json",
}

# Comments from last 30 days
TIME_THRESHOLD = datetime.now(timezone.utc) - timedelta(days=30)


def fetch_paginated(url):
    items = []
    while url:
        try:
            resp = requests.get(url, headers=HEADERS)
            resp.raise_for_status()
            data = resp.json()
            if isinstance(data, dict):
                items.extend(data.get('data', []))
                url = data.get('links', {}).get('next')
            elif isinstance(data, list):
                items.extend(data)
                url = None
            else:
                print(f"Unexpected response type from {url}: {type(data)}")
                url = None
            time.sleep(0.5)
        except requests.RequestException as e:
            print(f"Error fetching {url}: {e}")
            url = None
    return items


def get_asset(asset_id):
    cache = get_asset.cache
    if asset_id in cache:
        return cache[asset_id]
    try:
        resp = requests.get(f"{BASE_URL}/assets/{asset_id}", headers=HEADERS)
        resp.raise_for_status()
        asset = resp.json()
        info = {
            'name': asset.get('name', 'Unknown'),
            '_type': asset.get('_type', 'unknown'),
            'parent_id': asset.get('parent_id'),
            'updated_at': asset.get('updated_at'),
        }
        cache[asset_id] = info
        time.sleep(0.5)
        return info
    except requests.RequestException as e:
        print(f"Error fetching asset {asset_id}: {e}")
        return {'name': 'Unknown', '_type': 'unknown', 'parent_id': None, 'updated_at': None}

get_asset.cache = {}


def recent_files(root_id, threshold):
    print(f"Scanning assets updated since {threshold.isoformat().replace('+00:00','Z')}")
    queue = [root_id]
    files = []
    while queue:
        current = queue.pop(0)
        children = fetch_paginated(f"{BASE_URL}/assets/{current}/children")
        for item in children:
            if item.get('_type') == 'file':
                ts = item.get('updated_at')
                if ts:
                    try:
                        updated = datetime.fromisoformat(ts.replace('Z','+00:00'))
                        if updated >= threshold:
                            files.append(item)
                    except ValueError:
                        files.append(item)
                else:
                    files.append(item)
            elif item.get('_type') in ('folder', 'version_stack'):
                queue.append(item['id'])
    print(f"Found {len(files)} recent file assets")
    return files


def get_comments(asset_id):
    return fetch_paginated(f"{BASE_URL}/assets/{asset_id}/comments")


def folder_path(asset_id, root_id):
    segments = []
    current = asset_id
    if not current or current == root_id:
        return "/"
    while current and current != root_id:
        info = get_asset(current)
        if info['_type'] in ('folder', 'file', 'version_stack'):
            if current != asset_id:
                segments.append(info['name'])
        else:
            break
        current = info['parent_id']
    if not segments and asset_id != root_id:
        return "/"
    return "/" + "/".join(reversed(segments)) if segments else "/"


def main():
    if not FRAMEIO_TOKEN or not FRAMEIO_ROOT_ASSET_ID:
        print("FRAMEIO_TOKEN and FRAMEIO_ROOT_ASSET_ID must be set")
        return
    files = recent_files(FRAMEIO_ROOT_ASSET_ID, TIME_THRESHOLD)
    if not files:
        print("No recent files found")
        return
    results = []
    for f in files:
        aid = f['id']
        name = f['name']
        comments = get_comments(aid)
        path = folder_path(aid, FRAMEIO_ROOT_ASSET_ID)
        link = f"{APP_BASE_URL}/player/{aid}"
        for c in comments:
            ts_str = c.get('inserted_at')
            if not ts_str:
                continue
            try:
                ts = datetime.fromisoformat(ts_str.replace('Z','+00:00'))
            except ValueError:
                continue
            if ts >= TIME_THRESHOLD:
                results.append({
                    'comment_text': c.get('text', ''),
                    'comment_timestamp': ts_str,
                    'file_name': name,
                    'folder_path': path,
                    'file_link': link,
                })
    if results:
        out = 'frameio_recent_comments.json'
        with open(out, 'w', encoding='utf-8') as f:
            json.dump(results, f, indent=4, ensure_ascii=False)
        print(f"Exported {len(results)} comments to {out}")
    else:
        print("No comments found in the last 30 days")

if __name__ == '__main__':
    main()
