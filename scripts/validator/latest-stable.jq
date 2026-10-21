# The newest stable release of @bids/validator in a JSR meta.json, whatever its major version.
#
# Prereleases such as 3.0.0-alpha.4 and yanked releases never match. Versions compare part by part
# as numbers, so 2.0.10 sorts above 2.0.2. bump-validator.yml runs this program; its test runs it
# against a real JSR snapshot.
[.versions | to_entries[] | select(.value.yanked != true) | .key | select(test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))]
| sort_by(split(".") | map(tonumber))
| last // error("no stable release of @bids/validator in the JSR metadata")
