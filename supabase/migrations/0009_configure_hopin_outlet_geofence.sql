-- HOPIN Production Migration 0009: Configure HOPIN Cafe Surabaya Geofence Coordinates
-- Source: Google Maps HOPIN Cafe Surabaya (-7.277997, 112.7464245)

update public.outlet_settings
set latitude = -7.277997,
    longitude = 112.7464245,
    geofence_radius_m = 100,
    max_accuracy_m = 50,
    system_mode = 'PRODUCTION',
    updated_at = clock_timestamp()
where outlet_id = '11111111-1111-1111-1111-111111111111';
