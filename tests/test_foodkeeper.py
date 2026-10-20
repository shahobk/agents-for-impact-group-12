from agent.foodkeeper import lookup_foodkeeper


def test_spinach_advisory_comes_from_bundled_foodkeeper_without_deadline_override():
    result = lookup_foodkeeper(
        "ten crates of refrigerated spinach", "refrigerated"
    )

    assert result is not None
    assert result["source"] == "USDA FoodKeeper bundled dataset"
    assert result["product_id"] == "291"
    assert result["guidance"]["from_date_of_purchase_refrigerate_output_display_only"] == "3 - 7 Days"
    assert result["donor_deadline_authoritative"] is True
    assert "deadline" not in result


def test_unknown_product_has_no_invented_advisory():
    assert lookup_foodkeeper("xyzzy unfamiliar donation", "ambient") is None
