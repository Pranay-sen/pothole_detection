import requests

# Test admin API (all potholes with status)
r = requests.get("http://127.0.0.1:5000/admin/potholes")
data = r.json()
print(f"Admin API: {len(data)} total potholes")
for p in data:
    print(f"  #{p['id']} status={p.get('status','?')}")

print()

# Test public API (only active)
r2 = requests.get("http://127.0.0.1:8080/api/potholes")
data2 = r2.json()
print(f"Public API: {len(data2)} active potholes")
for p in data2:
    print(f"  #{p['id']}")

print()
print(f"RESULT: Admin shows {len(data)}, Public shows {len(data2)}")
if len(data) != len(data2):
    fixed = len(data) - len(data2)
    print(f"  -> {fixed} pothole(s) correctly filtered from public view")
