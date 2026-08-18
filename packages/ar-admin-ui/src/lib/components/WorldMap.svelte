<script lang="ts">
	/**
	 * WorldMap Component
	 *
	 * Interactive world map visualization for Scale page.
	 * Shows Cloudflare datacenter locations, region highlighting,
	 * and animated traffic arcs based on region selection.
	 *
	 * Design: Cyberpunk / Data Flow Visualization
	 * - Dark base with electronic glow effects
	 * - Neon cyan and electric blue accents
	 * - Animated traffic pulses between regions
	 */
	import { onMount } from 'svelte';
	import * as d3 from 'd3';
	import type { FeatureCollection, Feature, Geometry } from 'geojson';
	import { LL } from '$i18n/i18n-svelte';
	import {
		NATIVE_DO_PLACEMENT_REGIONS,
		isLocationHintRegion,
		isNativeDoPlacementRegion,
		resolveNativeDoPlacementRegions
	} from '$lib/region-map';

	// =========================================================================
	// Types
	// =========================================================================
	interface CountryProperties {
		CONTINENT: string;
		NAME: string;
		ISO_A3: string;
		[key: string]: unknown;
	}

	interface Datacenter {
		region: string;
		city: string;
		lat: number;
		lon: number;
	}

	// =========================================================================
	// Props
	// =========================================================================
	let {
		selectedRegions = [],
		regionDistribution: _regionDistribution = {},
		onRegionClick
	}: {
		selectedRegions: string[];
		regionDistribution: Record<string, number>;
		onRegionClick?: (region: string) => void;
	} = $props();

	// Note: _regionDistribution prop is currently unused (all arcs have uniform weight)
	// but kept for potential future use with weighted arc visualization

	// =========================================================================
	// Constants
	// =========================================================================

	// Representative Cloudflare DO placement locations used by the visualization.
	// Source: https://where.durableobjects.live
	// AFR and ME are valid hints, but Cloudflare currently places their DOs in a nearby region.
	const CF_DATACENTERS: Datacenter[] = [
		// APAC (Asia Pacific) - 5 DCs
		{ region: 'apac', city: 'Tokyo', lat: 35.76, lon: 140.39 }, // NRT
		{ region: 'apac', city: 'Osaka', lat: 34.43, lon: 135.24 }, // KIX
		{ region: 'apac', city: 'Singapore', lat: 1.35, lon: 103.99 }, // SIN
		{ region: 'apac', city: 'Hong Kong', lat: 22.31, lon: 113.92 }, // HKG
		{ region: 'apac', city: 'Seoul', lat: 37.47, lon: 126.45 }, // ICN
		// ENAM (Eastern North America) - 5 DCs
		{ region: 'enam', city: 'Ashburn', lat: 38.94, lon: -77.46 }, // IAD
		{ region: 'enam', city: 'Newark', lat: 40.69, lon: -74.17 }, // EWR
		{ region: 'enam', city: 'Atlanta', lat: 33.64, lon: -84.43 }, // ATL
		{ region: 'enam', city: 'Dallas', lat: 32.9, lon: -97.04 }, // DFW
		{ region: 'enam', city: 'Miami', lat: 25.79, lon: -80.29 }, // MIA
		// WNAM (Western North America) - 4 DCs
		{ region: 'wnam', city: 'San Jose', lat: 37.36, lon: -121.93 }, // SJC
		{ region: 'wnam', city: 'Los Angeles', lat: 33.94, lon: -118.41 }, // LAX
		{ region: 'wnam', city: 'Seattle', lat: 47.45, lon: -122.31 }, // SEA
		{ region: 'wnam', city: 'Denver', lat: 39.86, lon: -104.67 }, // DEN
		// WEUR (Western Europe) - 13 DCs
		{ region: 'weur', city: 'Amsterdam', lat: 52.31, lon: 4.77 }, // AMS
		{ region: 'weur', city: 'Frankfurt', lat: 50.03, lon: 8.56 }, // FRA
		{ region: 'weur', city: 'London', lat: 51.47, lon: -0.46 }, // LHR
		{ region: 'weur', city: 'Paris', lat: 49.01, lon: 2.55 }, // CDG
		{ region: 'weur', city: 'Stockholm', lat: 59.65, lon: 17.93 }, // ARN
		{ region: 'weur', city: 'Zurich', lat: 47.46, lon: 8.55 }, // ZRH
		{ region: 'weur', city: 'Lisbon', lat: 38.78, lon: -9.14 }, // LIS
		{ region: 'weur', city: 'Madrid', lat: 40.47, lon: -3.56 }, // MAD
		{ region: 'weur', city: 'Marseille', lat: 43.44, lon: 5.21 }, // MRS
		{ region: 'weur', city: 'Milan', lat: 45.63, lon: 8.73 }, // MXP
		// EEUR (Eastern Europe) - representative placement locations
		{ region: 'eeur', city: 'Warsaw', lat: 52.17, lon: 20.97 }, // WAW
		{ region: 'eeur', city: 'Vienna', lat: 48.11, lon: 16.57 }, // VIE
		{ region: 'eeur', city: 'Prague', lat: 50.1, lon: 14.26 }, // PRG
		// OC (Oceania) - 4 DCs
		{ region: 'oc', city: 'Sydney', lat: -33.95, lon: 151.18 }, // SYD
		{ region: 'oc', city: 'Auckland', lat: -37.01, lon: 174.79 }, // AKL
		{ region: 'oc', city: 'Melbourne', lat: -37.67, lon: 144.84 }, // MEL
		{ region: 'oc', city: 'Brisbane', lat: -27.38, lon: 153.12 } // BNE
	];

	// GeoJSON continent to Authrim region mapping
	const CONTINENT_TO_REGION: Record<string, string> = {
		Asia: 'apac',
		'North America': 'enam', // Default to enam, but we'll check longitude for wnam
		Europe: 'weur',
		Africa: 'afr',
		Oceania: 'oc',
		'South America': 'enam', // Route to nearest (enam)
		Antarctica: 'oc'
	};

	// Cloudflare PoP locations (IATA codes with coordinates)
	// Source: https://github.com/LufsX/Cloudflare-Data-Center-IATA-Code-list
	// ~270 PoP locations worldwide
	interface CloudflarePoP {
		iata: string;
		lat: number;
		lon: number;
	}

	const CLOUDFLARE_POPS: CloudflarePoP[] = [
		// North America - USA
		{ iata: 'ABQ', lat: 35.04, lon: -106.61 }, // Albuquerque
		{ iata: 'ATL', lat: 33.64, lon: -84.43 }, // Atlanta
		{ iata: 'AUS', lat: 30.19, lon: -97.67 }, // Austin
		{ iata: 'BNA', lat: 36.12, lon: -86.68 }, // Nashville
		{ iata: 'BOS', lat: 42.36, lon: -71.01 }, // Boston
		{ iata: 'BUF', lat: 42.94, lon: -78.73 }, // Buffalo
		{ iata: 'CLE', lat: 41.41, lon: -81.85 }, // Cleveland
		{ iata: 'CLT', lat: 35.21, lon: -80.94 }, // Charlotte
		{ iata: 'CMH', lat: 39.99, lon: -82.88 }, // Columbus
		{ iata: 'DEN', lat: 39.86, lon: -104.67 }, // Denver
		{ iata: 'DFW', lat: 32.9, lon: -97.04 }, // Dallas
		{ iata: 'DTW', lat: 42.21, lon: -83.35 }, // Detroit
		{ iata: 'EWR', lat: 40.69, lon: -74.17 }, // Newark
		{ iata: 'HNL', lat: 21.32, lon: -157.92 }, // Honolulu
		{ iata: 'IAD', lat: 38.94, lon: -77.46 }, // Ashburn
		{ iata: 'IAH', lat: 29.98, lon: -95.34 }, // Houston
		{ iata: 'IND', lat: 39.72, lon: -86.29 }, // Indianapolis
		{ iata: 'JAX', lat: 30.49, lon: -81.69 }, // Jacksonville
		{ iata: 'LAS', lat: 36.08, lon: -115.15 }, // Las Vegas
		{ iata: 'LAX', lat: 33.94, lon: -118.41 }, // Los Angeles
		{ iata: 'MCI', lat: 39.3, lon: -94.71 }, // Kansas City
		{ iata: 'MEM', lat: 35.04, lon: -89.98 }, // Memphis
		{ iata: 'MIA', lat: 25.79, lon: -80.29 }, // Miami
		{ iata: 'MSP', lat: 44.88, lon: -93.22 }, // Minneapolis
		{ iata: 'OKC', lat: 35.39, lon: -97.6 }, // Oklahoma City
		{ iata: 'OMA', lat: 41.3, lon: -95.89 }, // Omaha
		{ iata: 'ORD', lat: 41.98, lon: -87.9 }, // Chicago
		{ iata: 'PDX', lat: 45.59, lon: -122.6 }, // Portland
		{ iata: 'PHL', lat: 39.87, lon: -75.24 }, // Philadelphia
		{ iata: 'PHX', lat: 33.43, lon: -112.01 }, // Phoenix
		{ iata: 'PIT', lat: 40.49, lon: -80.23 }, // Pittsburgh
		{ iata: 'RDU', lat: 35.88, lon: -78.79 }, // Durham
		{ iata: 'SAN', lat: 32.73, lon: -117.19 }, // San Diego
		{ iata: 'SAT', lat: 29.53, lon: -98.47 }, // San Antonio
		{ iata: 'SEA', lat: 47.45, lon: -122.31 }, // Seattle
		{ iata: 'SFO', lat: 37.62, lon: -122.38 }, // San Francisco
		{ iata: 'SJC', lat: 37.36, lon: -121.93 }, // San Jose
		{ iata: 'SLC', lat: 40.79, lon: -111.98 }, // Salt Lake City
		{ iata: 'STL', lat: 38.75, lon: -90.37 }, // St. Louis
		{ iata: 'TPA', lat: 27.98, lon: -82.53 }, // Tampa
		// North America - Canada
		{ iata: 'YHZ', lat: 44.88, lon: -63.51 }, // Halifax
		{ iata: 'YOW', lat: 45.32, lon: -75.67 }, // Ottawa
		{ iata: 'YUL', lat: 45.47, lon: -73.74 }, // Montreal
		{ iata: 'YVR', lat: 49.19, lon: -123.18 }, // Vancouver
		{ iata: 'YWG', lat: 49.91, lon: -97.24 }, // Winnipeg
		{ iata: 'YYC', lat: 51.11, lon: -114.01 }, // Calgary
		{ iata: 'YYZ', lat: 43.68, lon: -79.63 }, // Toronto
		// Latin America - Mexico
		{ iata: 'GDL', lat: 20.52, lon: -103.31 }, // Guadalajara
		{ iata: 'MEX', lat: 19.44, lon: -99.07 }, // Mexico City
		{ iata: 'QRO', lat: 20.62, lon: -100.19 }, // Queretaro
		// Latin America - Brazil
		{ iata: 'BSB', lat: -15.87, lon: -47.92 }, // Brasilia
		{ iata: 'CNF', lat: -19.62, lon: -43.97 }, // Belo Horizonte
		{ iata: 'CWB', lat: -25.53, lon: -49.17 }, // Curitiba
		{ iata: 'FOR', lat: -3.78, lon: -38.53 }, // Fortaleza
		{ iata: 'GIG', lat: -22.81, lon: -43.25 }, // Rio de Janeiro
		{ iata: 'GRU', lat: -23.43, lon: -46.47 }, // Sao Paulo
		{ iata: 'POA', lat: -29.99, lon: -51.17 }, // Porto Alegre
		{ iata: 'REC', lat: -8.13, lon: -34.92 }, // Recife
		{ iata: 'SSA', lat: -12.91, lon: -38.33 }, // Salvador
		// Latin America - Others
		{ iata: 'BOG', lat: 4.7, lon: -74.15 }, // Bogota
		{ iata: 'EZE', lat: -34.82, lon: -58.54 }, // Buenos Aires
		{ iata: 'GUA', lat: 14.58, lon: -90.53 }, // Guatemala City
		{ iata: 'GYE', lat: -2.16, lon: -79.88 }, // Guayaquil
		{ iata: 'LIM', lat: -12.02, lon: -77.11 }, // Lima
		{ iata: 'PTY', lat: 9.07, lon: -79.38 }, // Panama City
		{ iata: 'SCL', lat: -33.39, lon: -70.79 }, // Santiago
		{ iata: 'SJO', lat: 9.99, lon: -84.21 }, // San Jose, Costa Rica
		{ iata: 'UIO', lat: -0.13, lon: -78.36 }, // Quito
		// Caribbean
		{ iata: 'KIN', lat: 17.94, lon: -76.79 }, // Kingston
		{ iata: 'SDQ', lat: 18.43, lon: -69.67 }, // Santo Domingo
		{ iata: 'SJU', lat: 18.44, lon: -66.0 }, // San Juan
		// Europe - Western
		{ iata: 'AMS', lat: 52.31, lon: 4.77 }, // Amsterdam
		{ iata: 'BCN', lat: 41.3, lon: 2.08 }, // Barcelona
		{ iata: 'BRU', lat: 50.9, lon: 4.48 }, // Brussels
		{ iata: 'CDG', lat: 49.01, lon: 2.55 }, // Paris
		{ iata: 'DUB', lat: 53.42, lon: -6.27 }, // Dublin
		{ iata: 'DUS', lat: 51.29, lon: 6.77 }, // Dusseldorf
		{ iata: 'EDI', lat: 55.95, lon: -3.37 }, // Edinburgh
		{ iata: 'FCO', lat: 41.8, lon: 12.25 }, // Rome
		{ iata: 'FRA', lat: 50.03, lon: 8.57 }, // Frankfurt
		{ iata: 'GVA', lat: 46.24, lon: 6.11 }, // Geneva
		{ iata: 'HAM', lat: 53.63, lon: 10.01 }, // Hamburg
		{ iata: 'LHR', lat: 51.47, lon: -0.46 }, // London
		{ iata: 'LIS', lat: 38.77, lon: -9.13 }, // Lisbon
		{ iata: 'LUX', lat: 49.63, lon: 6.21 }, // Luxembourg
		{ iata: 'LYS', lat: 45.73, lon: 5.08 }, // Lyon
		{ iata: 'MAD', lat: 40.47, lon: -3.56 }, // Madrid
		{ iata: 'MAN', lat: 53.35, lon: -2.28 }, // Manchester
		{ iata: 'MRS', lat: 43.44, lon: 5.22 }, // Marseille
		{ iata: 'MUC', lat: 48.35, lon: 11.79 }, // Munich
		{ iata: 'MXP', lat: 45.63, lon: 8.72 }, // Milan
		{ iata: 'TXL', lat: 52.56, lon: 13.29 }, // Berlin
		{ iata: 'VIE', lat: 48.11, lon: 16.57 }, // Vienna
		{ iata: 'ZRH', lat: 47.46, lon: 8.55 }, // Zurich
		// Europe - Nordic
		{ iata: 'ARN', lat: 59.65, lon: 17.94 }, // Stockholm
		{ iata: 'CPH', lat: 55.62, lon: 12.66 }, // Copenhagen
		{ iata: 'HEL', lat: 60.32, lon: 24.95 }, // Helsinki
		{ iata: 'KEF', lat: 63.99, lon: -22.62 }, // Reykjavik
		{ iata: 'OSL', lat: 60.19, lon: 11.1 }, // Oslo
		// Europe - Eastern
		{ iata: 'ATH', lat: 37.94, lon: 23.94 }, // Athens
		{ iata: 'BEG', lat: 44.82, lon: 20.29 }, // Belgrade
		{ iata: 'BTS', lat: 48.17, lon: 17.21 }, // Bratislava
		{ iata: 'BUD', lat: 47.44, lon: 19.26 }, // Budapest
		{ iata: 'KBP', lat: 50.34, lon: 30.89 }, // Kyiv
		{ iata: 'OTP', lat: 44.57, lon: 26.08 }, // Bucharest
		{ iata: 'PRG', lat: 50.1, lon: 14.26 }, // Prague
		{ iata: 'RIX', lat: 56.92, lon: 23.97 }, // Riga
		{ iata: 'SOF', lat: 42.7, lon: 23.32 }, // Sofia
		{ iata: 'TLL', lat: 59.41, lon: 24.83 }, // Tallinn
		{ iata: 'VNO', lat: 54.64, lon: 25.29 }, // Vilnius
		{ iata: 'WAW', lat: 52.17, lon: 20.97 }, // Warsaw
		{ iata: 'ZAG', lat: 45.74, lon: 16.07 }, // Zagreb
		// Europe - Russia
		{ iata: 'DME', lat: 55.41, lon: 37.91 }, // Moscow
		{ iata: 'LED', lat: 59.8, lon: 30.26 }, // St. Petersburg
		// Middle East
		{ iata: 'AMM', lat: 31.72, lon: 35.99 }, // Amman
		{ iata: 'BAH', lat: 26.27, lon: 50.64 }, // Bahrain
		{ iata: 'BEY', lat: 33.82, lon: 35.49 }, // Beirut
		{ iata: 'DOH', lat: 25.26, lon: 51.57 }, // Doha
		{ iata: 'DXB', lat: 25.25, lon: 55.36 }, // Dubai
		{ iata: 'IST', lat: 41.27, lon: 28.75 }, // Istanbul
		{ iata: 'JED', lat: 21.68, lon: 39.16 }, // Jeddah
		{ iata: 'KWI', lat: 29.23, lon: 47.97 }, // Kuwait
		{ iata: 'MCT', lat: 23.59, lon: 58.28 }, // Muscat
		{ iata: 'RUH', lat: 24.96, lon: 46.7 }, // Riyadh
		{ iata: 'TLV', lat: 32.01, lon: 34.88 }, // Tel Aviv
		// Africa
		{ iata: 'ABJ', lat: 5.26, lon: -3.93 }, // Abidjan
		{ iata: 'ACC', lat: 5.61, lon: -0.17 }, // Accra
		{ iata: 'ADD', lat: 8.98, lon: 38.8 }, // Addis Ababa
		{ iata: 'ALG', lat: 36.69, lon: 3.22 }, // Algiers
		{ iata: 'CAI', lat: 30.11, lon: 31.4 }, // Cairo
		{ iata: 'CPT', lat: -33.97, lon: 18.6 }, // Cape Town
		{ iata: 'DAR', lat: -6.88, lon: 39.2 }, // Dar es Salaam
		{ iata: 'DKR', lat: 14.74, lon: -17.49 }, // Dakar
		{ iata: 'DUR', lat: -29.97, lon: 30.95 }, // Durban
		{ iata: 'JNB', lat: -26.14, lon: 28.25 }, // Johannesburg
		{ iata: 'KGL', lat: -1.97, lon: 30.14 }, // Kigali
		{ iata: 'LAD', lat: -8.86, lon: 13.23 }, // Luanda
		{ iata: 'LOS', lat: 6.58, lon: 3.32 }, // Lagos
		{ iata: 'NBO', lat: -1.32, lon: 36.93 }, // Nairobi
		{ iata: 'TUN', lat: 36.85, lon: 10.23 }, // Tunis
		// Asia - Japan
		{ iata: 'FUK', lat: 33.59, lon: 130.45 }, // Fukuoka
		{ iata: 'KIX', lat: 34.43, lon: 135.24 }, // Osaka
		{ iata: 'NRT', lat: 35.76, lon: 140.39 }, // Tokyo
		{ iata: 'OKA', lat: 26.2, lon: 127.65 }, // Naha/Okinawa
		// Asia - China
		{ iata: 'CAN', lat: 23.39, lon: 113.3 }, // Guangzhou
		{ iata: 'CKG', lat: 29.72, lon: 106.64 }, // Chongqing
		{ iata: 'CTU', lat: 30.58, lon: 103.95 }, // Chengdu
		{ iata: 'HGH', lat: 30.23, lon: 120.43 }, // Hangzhou
		{ iata: 'PKX', lat: 39.51, lon: 116.41 }, // Beijing
		{ iata: 'SHA', lat: 31.2, lon: 121.34 }, // Shanghai
		{ iata: 'SZX', lat: 22.64, lon: 113.81 }, // Shenzhen
		{ iata: 'TSN', lat: 39.12, lon: 117.35 }, // Tianjin
		{ iata: 'XIY', lat: 34.44, lon: 108.75 }, // Xi'an
		// Asia - South Korea
		{ iata: 'ICN', lat: 37.46, lon: 126.44 }, // Seoul
		// Asia - Taiwan/HK/Macau
		{ iata: 'HKG', lat: 22.31, lon: 113.91 }, // Hong Kong
		{ iata: 'KHH', lat: 22.58, lon: 120.35 }, // Kaohsiung
		{ iata: 'TPE', lat: 25.08, lon: 121.23 }, // Taipei
		// Asia - Southeast
		{ iata: 'BKK', lat: 13.69, lon: 100.75 }, // Bangkok
		{ iata: 'CEB', lat: 10.31, lon: 123.98 }, // Cebu
		{ iata: 'CGK', lat: -6.13, lon: 106.66 }, // Jakarta
		{ iata: 'CNX', lat: 18.77, lon: 98.96 }, // Chiang Mai
		{ iata: 'DAD', lat: 16.04, lon: 108.2 }, // Da Nang
		{ iata: 'DPS', lat: -8.75, lon: 115.17 }, // Bali
		{ iata: 'HAN', lat: 21.22, lon: 105.81 }, // Hanoi
		{ iata: 'JOG', lat: -7.79, lon: 110.43 }, // Yogyakarta
		{ iata: 'KUL', lat: 2.75, lon: 101.71 }, // Kuala Lumpur
		{ iata: 'MNL', lat: 14.51, lon: 121.02 }, // Manila
		{ iata: 'PNH', lat: 11.55, lon: 104.84 }, // Phnom Penh
		{ iata: 'SGN', lat: 10.82, lon: 106.65 }, // Ho Chi Minh City
		{ iata: 'SIN', lat: 1.36, lon: 103.99 }, // Singapore
		{ iata: 'VTE', lat: 17.99, lon: 102.56 }, // Vientiane
		// Asia - South
		{ iata: 'AMD', lat: 23.07, lon: 72.63 }, // Ahmedabad
		{ iata: 'BLR', lat: 13.2, lon: 77.71 }, // Bangalore
		{ iata: 'BOM', lat: 19.09, lon: 72.87 }, // Mumbai
		{ iata: 'CCU', lat: 22.65, lon: 88.45 }, // Kolkata
		{ iata: 'CMB', lat: 7.18, lon: 79.88 }, // Colombo
		{ iata: 'COK', lat: 10.15, lon: 76.4 }, // Kochi
		{ iata: 'DAC', lat: 23.84, lon: 90.4 }, // Dhaka
		{ iata: 'DEL', lat: 28.56, lon: 77.1 }, // Delhi
		{ iata: 'HYD', lat: 17.23, lon: 78.43 }, // Hyderabad
		{ iata: 'ISB', lat: 33.62, lon: 73.1 }, // Islamabad
		{ iata: 'KHI', lat: 24.91, lon: 67.16 }, // Karachi
		{ iata: 'KTM', lat: 27.7, lon: 85.36 }, // Kathmandu
		{ iata: 'LHE', lat: 31.52, lon: 74.4 }, // Lahore
		{ iata: 'MAA', lat: 12.99, lon: 80.17 }, // Chennai
		// Asia - Central
		{ iata: 'ALA', lat: 43.35, lon: 77.04 }, // Almaty
		{ iata: 'EVN', lat: 40.15, lon: 44.4 }, // Yerevan
		{ iata: 'GYD', lat: 40.47, lon: 50.05 }, // Baku
		{ iata: 'TAS', lat: 41.26, lon: 69.28 }, // Tashkent
		{ iata: 'TBS', lat: 41.67, lon: 44.95 }, // Tbilisi
		{ iata: 'ULN', lat: 47.84, lon: 106.77 }, // Ulaanbaatar
		// Oceania
		{ iata: 'ADL', lat: -34.94, lon: 138.53 }, // Adelaide
		{ iata: 'AKL', lat: -37.01, lon: 174.79 }, // Auckland
		{ iata: 'BNE', lat: -27.38, lon: 153.12 }, // Brisbane
		{ iata: 'CBR', lat: -35.31, lon: 149.19 }, // Canberra
		{ iata: 'CHC', lat: -43.49, lon: 172.53 }, // Christchurch
		{ iata: 'GUM', lat: 13.48, lon: 144.8 }, // Guam
		{ iata: 'MEL', lat: -37.67, lon: 144.84 }, // Melbourne
		{ iata: 'NOU', lat: -22.01, lon: 166.21 }, // Noumea
		{ iata: 'PER', lat: -31.94, lon: 115.97 }, // Perth
		{ iata: 'SYD', lat: -33.95, lon: 151.18 }, // Sydney
		// Other
		{ iata: 'ANC', lat: 61.17, lon: -150.0 }, // Anchorage
		{ iata: 'MRU', lat: -20.43, lon: 57.68 } // Mauritius
	];

	// =========================================================================
	// State
	// =========================================================================
	let containerElement: HTMLDivElement;
	let svgElement: SVGSVGElement;
	let geoData: FeatureCollection | null = $state(null);
	let width = $state(800);
	let height = $state(400);

	// =========================================================================
	// D3 Setup
	// =========================================================================
	const projection = d3.geoNaturalEarth1();
	const pathGenerator = d3.geoPath(projection);

	// =========================================================================
	// Helper Functions
	// =========================================================================

	function getRegionFromFeature(feature: Feature<Geometry, CountryProperties>): string {
		const continent = feature.properties?.CONTINENT;
		if (!continent) return 'apac';

		// Special handling for North America - split by longitude
		if (continent === 'North America') {
			// Use centroid to determine east/west
			const centroid = d3.geoCentroid(feature);
			return centroid[0] < -100 ? 'wnam' : 'enam';
		}

		// Special handling for Middle East countries
		const name = feature.properties?.NAME;
		const middleEastCountries = [
			'Saudi Arabia',
			'United Arab Emirates',
			'Qatar',
			'Kuwait',
			'Bahrain',
			'Oman',
			'Yemen',
			'Iraq',
			'Iran',
			'Israel',
			'Jordan',
			'Lebanon',
			'Syria',
			'Palestine'
		];
		if (middleEastCountries.includes(name)) {
			return 'me';
		}

		const easternEuropeCountries = [
			'Albania',
			'Austria',
			'Belarus',
			'Bosnia and Herz.',
			'Bulgaria',
			'Croatia',
			'Czechia',
			'Estonia',
			'Greece',
			'Hungary',
			'Latvia',
			'Lithuania',
			'Moldova',
			'Montenegro',
			'North Macedonia',
			'Poland',
			'Romania',
			'Russia',
			'Serbia',
			'Slovakia',
			'Slovenia',
			'Ukraine'
		];
		if (easternEuropeCountries.includes(name)) {
			return 'eeur';
		}

		return CONTINENT_TO_REGION[continent] || 'apac';
	}

	function isRegionSelected(region: string): boolean {
		return selectedRegions.includes(region);
	}

	// Determine region from coordinates
	function getRegionFromCoords(lat: number, lon: number): string {
		// Middle East check first (specific region)
		if (lon >= 25 && lon <= 60 && lat >= 12 && lat <= 42) {
			return 'me';
		}
		// Oceania
		if ((lon >= 110 && lat <= -10) || (lon >= 165 && lat <= -30)) {
			return 'oc';
		}
		// Africa
		if (lon >= -20 && lon <= 55 && lat >= -35 && lat <= 37 && !(lat > 30 && lon > 25)) {
			return 'afr';
		}
		// Europe (including Russia west of Urals)
		if (lon >= -10 && lon <= 60 && lat >= 35 && lat <= 72) {
			return lon >= 14 ? 'eeur' : 'weur';
		}
		// North America
		if (lon >= -170 && lon <= -50 && lat >= 15 && lat <= 72) {
			return lon < -100 ? 'wnam' : 'enam';
		}
		// South America -> route to enam
		if (lon >= -85 && lon <= -30 && lat >= -55 && lat <= 15) {
			return 'enam';
		}
		// Default to APAC (Asia-Pacific)
		return 'apac';
	}

	let selectedNativePlacementRegions = $derived([
		...new Set(selectedRegions.flatMap(resolveNativeDoPlacementRegions))
	]);

	function findNearestDatacenter(
		sourceLat: number,
		sourceLon: number,
		targetRegions?: string[]
	): { datacenter: Datacenter; region: string } | null {
		// Find the nearest datacenter from specified regions (or all if not specified)
		let regionsToSearch: string[];

		if (targetRegions && targetRegions.length > 0) {
			// Map nearby-placement hints to the native region used by this visualization.
			regionsToSearch = targetRegions.flatMap(resolveNativeDoPlacementRegions);
			// Remove duplicates
			regionsToSearch = [...new Set(regionsToSearch)];
		} else {
			regionsToSearch = [...NATIVE_DO_PLACEMENT_REGIONS];
		}

		let nearestDc: Datacenter | null = null;
		let nearestRegion = '';
		let minDistance = Infinity;

		for (const region of regionsToSearch) {
			const dcs = CF_DATACENTERS.filter((dc) => dc.region === region);
			for (const dc of dcs) {
				const dist = Math.sqrt(Math.pow(dc.lon - sourceLon, 2) + Math.pow(dc.lat - sourceLat, 2));
				if (dist < minDistance) {
					minDistance = dist;
					nearestDc = dc;
					nearestRegion = region;
				}
			}
		}

		return nearestDc ? { datacenter: nearestDc, region: nearestRegion } : null;
	}

	// Get target datacenter for a PoP (used directly in template)
	function getTargetDatacenter(
		lat: number,
		lon: number
	): { dc: Datacenter; region: string; isSelected: boolean } | null {
		if (selectedRegions.length > 0) {
			// Find nearest among selected regions
			const nearest = findNearestDatacenter(lat, lon, selectedRegions);
			if (nearest) {
				return { dc: nearest.datacenter, region: nearest.region, isSelected: true };
			}
		}
		// Fallback: find nearest overall
		const nearestOverall = findNearestDatacenter(lat, lon);
		if (nearestOverall) {
			return { dc: nearestOverall.datacenter, region: nearestOverall.region, isSelected: false };
		}
		return null;
	}

	// =========================================================================
	// Reactive Updates
	// =========================================================================
	$effect(() => {
		if (svgElement && geoData) {
			// Update projection to fit container with asymmetric padding
			// Negative left padding shifts map left, cutting off empty Pacific
			// This crops the empty ocean west of Hawaii
			const leftPadding = -width * 0.12; // Crop ~12% from left (Pacific)
			const rightPadding = -width * 0.02; // Slight crop from right
			const topPadding = 5;
			const bottomPadding = 5;
			projection.fitExtent(
				[
					[leftPadding, topPadding],
					[width - rightPadding, height - bottomPadding]
				],
				geoData
			);
		}
	});

	// =========================================================================
	// Lifecycle
	// =========================================================================
	onMount(() => {
		// Load GeoJSON data asynchronously (IIFE to avoid async onMount type issue)
		(async () => {
			try {
				const response = await fetch('/geo/world.geo.json');
				geoData = await response.json();
			} catch (e) {
				console.error('Failed to load world map data:', e);
			}
		})();

		// Set up resize observer
		const resizeObserver = new ResizeObserver((entries) => {
			for (const entry of entries) {
				width = entry.contentRect.width;
				height = Math.max(300, entry.contentRect.width * 0.45);
			}
		});

		if (containerElement) {
			resizeObserver.observe(containerElement);
		}

		return () => {
			resizeObserver.disconnect();
		};
	});
</script>

<div class="world-map-container" bind:this={containerElement}>
	<!-- Background grid pattern -->
	<div class="grid-overlay"></div>

	<svg bind:this={svgElement} viewBox="0 0 {width} {height}" class="world-map-svg">
		<!-- Definitions for filters and gradients -->
		<defs>
			<!-- Glow filter for selected regions -->
			<filter id="glow-region" x="-50%" y="-50%" width="200%" height="200%">
				<feGaussianBlur stdDeviation="3" result="coloredBlur" />
				<feMerge>
					<feMergeNode in="coloredBlur" />
					<feMergeNode in="SourceGraphic" />
				</feMerge>
			</filter>

			<!-- Stronger glow for datacenters -->
			<filter id="glow-dc" x="-100%" y="-100%" width="300%" height="300%">
				<feGaussianBlur stdDeviation="4" result="coloredBlur" />
				<feMerge>
					<feMergeNode in="coloredBlur" />
					<feMergeNode in="SourceGraphic" />
				</feMerge>
			</filter>

			<!-- Arc glow with cyan-blue gradient effect -->
			<filter id="glow-arc" x="-30%" y="-30%" width="160%" height="160%">
				<feGaussianBlur stdDeviation="2.5" result="coloredBlur" />
				<feMerge>
					<feMergeNode in="coloredBlur" />
					<feMergeNode in="SourceGraphic" />
				</feMerge>
			</filter>

			<!-- Cyan-blue gradient for active arcs (horizontal direction) - Dark theme -->
			<linearGradient id="arc-gradient-active" x1="0%" y1="0%" x2="100%" y2="0%">
				<stop offset="0%" stop-color="var(--arc-start)" />
				<stop offset="35%" stop-color="var(--arc-mid)" />
				<stop offset="70%" stop-color="var(--arc-end-mid)" />
				<stop offset="100%" stop-color="var(--arc-end)" />
			</linearGradient>

			<!-- Subtle gray gradient for inactive arcs -->
			<linearGradient id="arc-gradient-inactive" x1="0%" y1="0%" x2="100%" y2="0%">
				<stop offset="0%" stop-color="var(--arc-inactive-start)" />
				<stop offset="50%" stop-color="var(--arc-inactive-mid)" />
				<stop offset="100%" stop-color="var(--arc-inactive-end)" />
			</linearGradient>
		</defs>

		<!-- Map content -->
		<g class="map-content">
			<!-- World map countries -->
			{#if geoData}
				<g class="countries">
					{#each geoData.features as feature, i (feature.properties?.ISO_A3 && feature.properties.ISO_A3 !== '-99' ? feature.properties.ISO_A3 : `unknown-${i}`)}
						{@const region = getRegionFromFeature(feature as Feature<Geometry, CountryProperties>)}
						{@const isSelected = isRegionSelected(region)}
						{@const isHintSupported = isLocationHintRegion(region)}
						{@const isNativePlacement = isNativeDoPlacementRegion(region)}
						<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
						<path
							d={pathGenerator(feature) || ''}
							class="country-path"
							class:selected={isSelected}
							class:non-do-capable={!isNativePlacement}
							data-region={region}
							onclick={() => isHintSupported && onRegionClick?.(region)}
							role={isHintSupported ? 'button' : 'img'}
							tabindex={isHintSupported ? 0 : -1}
							aria-label={`${feature.properties?.NAME || $LL.admin_scale_map_unknown()} - ${region}${
								isNativePlacement ? '' : ` (${$LL.admin_scale_region_nearby_placement()})`
							}`}
							onkeydown={(e) => isHintSupported && e.key === 'Enter' && onRegionClick?.(region)}
						/>
					{/each}
				</g>
			{/if}

			<!-- Traffic arcs (from all PoPs - rendered BEFORE dots so dots appear on top) -->
			<g class="traffic-arcs">
				{#each CLOUDFLARE_POPS as pop (pop.iata)}
					{@const sourcePos = projection([pop.lon, pop.lat])}
					{@const targetDc = getTargetDatacenter(pop.lat, pop.lon)}
					{@const targetPos = targetDc ? projection([targetDc.dc.lon, targetDc.dc.lat]) : null}
					{@const isActive = targetDc?.isSelected ?? false}
					{#if sourcePos && targetPos}
						{@const midX = (sourcePos[0] + targetPos[0]) / 2}
						{@const midY = (sourcePos[1] + targetPos[1]) / 2}
						{@const dist = Math.sqrt(
							Math.pow(targetPos[0] - sourcePos[0], 2) + Math.pow(targetPos[1] - sourcePos[1], 2)
						)}
						{@const curveHeight = Math.min(dist * 0.35, 80)}
						{@const arcPath = `M ${sourcePos[0]} ${sourcePos[1]} Q ${midX} ${midY - curveHeight} ${targetPos[0]} ${targetPos[1]}`}
						<!-- Use global gradients for better performance -->
						<path
							d={arcPath}
							class="arc-line"
							class:active={isActive}
							stroke={isActive ? 'url(#arc-gradient-active)' : 'url(#arc-gradient-inactive)'}
						/>
					{/if}
				{/each}
			</g>

			<!-- Cloudflare PoP points (small dots - rendered AFTER arcs so they appear on top) -->
			<g class="pop-points">
				{#each CLOUDFLARE_POPS as pop (pop.iata)}
					{@const pos = projection([pop.lon, pop.lat])}
					{@const popRegion = getRegionFromCoords(pop.lat, pop.lon)}
					{@const isInSelectedRegion = selectedRegions.includes(popRegion)}
					{#if pos}
						<circle
							cx={pos[0]}
							cy={pos[1]}
							r="1.2"
							class="pop-dot"
							class:highlight={isInSelectedRegion}
						>
							<title>{pop.iata}</title>
						</circle>
					{/if}
				{/each}
			</g>

			<!-- Primary DO datacenter points (larger, glowing) -->
			<g class="datacenters">
				{#each CF_DATACENTERS as dc (dc.city)}
					{@const pos = projection([dc.lon, dc.lat])}
					{@const isSelected = selectedNativePlacementRegions.includes(dc.region)}
					{#if pos}
						{#if isSelected}
							<g class="dc-group">
								<!-- Outer pulse ring -->
								<circle cx={pos[0]} cy={pos[1]} r="8" class="dc-pulse-ring" />
								<!-- Inner glow -->
								<circle cx={pos[0]} cy={pos[1]} r="4" class="dc-point active" />
								<title>{dc.city} ({dc.region.toUpperCase()})</title>
							</g>
						{:else}
							<circle cx={pos[0]} cy={pos[1]} r="2.5" class="dc-point inactive">
								<title>{dc.city} ({dc.region.toUpperCase()})</title>
							</circle>
						{/if}
					{/if}
				{/each}
			</g>
		</g>
	</svg>

	<!-- Legend -->
	<div class="map-legend">
		<div class="legend-item">
			<span class="legend-dot active"></span>
			<span>{$LL.admin_scale_map_active_region()}</span>
		</div>
		<div class="legend-item">
			<span class="legend-dot inactive"></span>
			<span>{$LL.admin_scale_map_inactive()}</span>
		</div>
		<div class="legend-item">
			<span class="legend-line"></span>
			<span>{$LL.admin_scale_map_traffic_flow()}</span>
		</div>
	</div>
</div>

<style>
	.world-map-container {
		position: relative;
		width: 100%;
		min-height: 300px;
		background: var(--map-bg);
		border-radius: var(--world-map-radius, var(--radius-lg, 12px));
		overflow: hidden;
		border: 1px solid var(--map-border);
	}

	/* Grid overlay for cyberpunk effect */
	.grid-overlay {
		position: absolute;
		inset: 0;
		background-image:
			linear-gradient(var(--map-grid-line) 1px, transparent 1px),
			linear-gradient(90deg, var(--map-grid-line) 1px, transparent 1px);
		background-size: 40px 40px;
		pointer-events: none;
		z-index: 1;
	}

	.world-map-svg {
		display: block;
		width: 100%;
		height: auto;
		position: relative;
		z-index: 2;
		/* Disable D3 zoom selection box */
		outline: none;
		-webkit-tap-highlight-color: transparent;
		user-select: none;
	}

	/* Hide any selection rectangles from D3 zoom */
	.world-map-svg :global(.selection) {
		display: none !important;
	}

	/* Country paths */
	.country-path {
		fill: var(--map-land-inactive);
		stroke: var(--map-border);
		stroke-width: 0.5px;
		cursor: pointer;
		transition:
			fill 0.3s ease,
			filter 0.3s ease;
	}

	.country-path:hover {
		fill: var(--map-land-hover);
	}

	.country-path.selected {
		fill: var(--map-land-active);
		filter: url(#glow-region);
	}

	/* Non-DO-capable regions (AFR, ME) - not clickable */
	.country-path.non-do-capable {
		cursor: inherit;
		opacity: 0.7;
	}

	.country-path.non-do-capable:hover {
		fill: var(--map-land-inactive);
	}

	/* Traffic arcs - gradient lines from all PoPs */
	.arc-line {
		fill: none;
		stroke-width: 0.6px;
		stroke-linecap: round;
		opacity: 0.7;
		transition:
			stroke-width 0.3s ease,
			opacity 0.3s ease,
			filter 0.3s ease;
	}

	.arc-line.active {
		stroke-width: 1px;
		opacity: 1;
		filter: url(#glow-arc);
	}

	/* Cloudflare PoP points - small dots */
	.pop-dot {
		fill: var(--pop-color);
		transition: fill 0.3s ease;
	}

	.pop-dot.highlight {
		fill: var(--pop-highlight);
	}

	/* Primary DO Datacenter points */
	.dc-point {
		transition: all 0.3s ease;
	}

	.dc-point.inactive {
		fill: var(--dc-inactive);
		opacity: 0.5;
	}

	.dc-point.active {
		fill: var(--dc-active);
		filter: url(#glow-dc);
	}

	/* Pulse animation for active datacenters */
	.dc-pulse-ring {
		fill: none;
		stroke: var(--dc-active);
		stroke-width: 1.5px;
		opacity: 0;
		animation: dcPulse 2s ease-out infinite;
	}

	@keyframes dcPulse {
		0% {
			r: 4;
			opacity: 0.8;
		}
		100% {
			r: 16;
			opacity: 0;
		}
	}

	/* Stagger pulse animations */
	.dc-group:nth-child(2n) .dc-pulse-ring {
		animation-delay: 0.5s;
	}
	.dc-group:nth-child(3n) .dc-pulse-ring {
		animation-delay: 1s;
	}
	.dc-group:nth-child(4n) .dc-pulse-ring {
		animation-delay: 1.5s;
	}

	/* Legend */
	.map-legend {
		position: absolute;
		bottom: 12px;
		left: 12px;
		display: flex;
		gap: 16px;
		padding: 8px 12px;
		background: var(--map-legend-bg, var(--color-surface));
		border-radius: var(--radius-control);
		border: 1px solid var(--map-legend-border, var(--map-border, var(--color-border)));
		font-size: 0.75rem;
		color: var(--map-legend-color, var(--color-text-muted));
		z-index: 3;
	}

	.legend-item {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.legend-dot {
		width: 8px;
		height: 8px;
		border-radius: var(--map-dot-radius);
	}

	.legend-dot.active {
		background: var(--dc-active);
		box-shadow: var(--map-dot-active-shadow);
	}

	.legend-dot.inactive {
		background: var(--dc-inactive);
	}

	.legend-line {
		width: 20px;
		height: 2px;
		background: linear-gradient(90deg, transparent, var(--arc-color), transparent);
	}

	/* CSS Variables for theming */
	.world-map-container {
		--map-bg: var(--world-map-bg, #0a0a0f);
		--map-legend-bg: color-mix(in srgb, var(--color-surface) 86%, transparent);
		--map-legend-border: var(--world-map-legend-border, var(--map-border));
		--map-legend-color: var(--color-text-muted);
		--map-grid-line: var(--world-map-grid-line, rgba(0, 255, 213, 0.03));
		--map-land-inactive: var(--world-map-land-inactive, #1a1a2e);
		--map-land-active: var(--world-map-land-active, #1e3a5f);
		--map-land-hover: var(--world-map-land-hover, #252540);
		--map-border: var(--world-map-border, #2a2a4e);
		--dc-active: var(--world-map-dc-active, #00ffd5);
		--dc-inactive: var(--world-map-dc-inactive, #4a4a6a);
		--pop-color: var(--world-map-pop-color, rgba(100, 100, 140, 0.4));
		--pop-highlight: var(--world-map-pop-highlight, rgba(0, 255, 213, 0.6));
		--arc-color: var(--world-map-arc-color, rgba(0, 255, 213, 0.7));
		--arc-color-inactive: var(--world-map-arc-color-inactive, rgba(100, 100, 140, 0.2));
		--map-dot-radius: var(--world-map-dot-radius, var(--status-dot-radius, 50%));
		--map-dot-active-shadow: var(--world-map-dot-active-shadow, 0 0 8px var(--dc-active));
		/* Arc gradient colors - dark theme */
		--arc-start: var(--world-map-arc-start, rgba(0, 255, 213, 0.15));
		--arc-mid: var(--world-map-arc-mid, rgba(59, 130, 246, 0.5));
		--arc-end-mid: var(--world-map-arc-end-mid, rgba(0, 200, 220, 0.7));
		--arc-end: var(--world-map-arc-end, rgba(0, 255, 213, 0.95));
		--arc-inactive-start: var(--world-map-arc-inactive-start, rgba(100, 100, 140, 0.05));
		--arc-inactive-mid: var(--world-map-arc-inactive-mid, rgba(100, 100, 140, 0.12));
		--arc-inactive-end: var(--world-map-arc-inactive-end, rgba(100, 100, 140, 0.2));
	}

	/* Light theme adjustments */
	:global([data-theme='light']) .world-map-container {
		--map-bg: var(--world-map-light-bg, #f0f4f8);
		--map-grid-line: var(--world-map-light-grid-line, rgba(14, 165, 233, 0.05));
		--map-land-inactive: var(--world-map-light-land-inactive, #d1d5db);
		--map-land-active: var(--world-map-light-land-active, #93c5fd);
		--map-land-hover: var(--world-map-light-land-hover, #bfdbfe);
		--map-border: var(--world-map-light-border, #9ca3af);
		--dc-active: var(--world-map-light-dc-active, #0ea5e9);
		--dc-inactive: var(--world-map-light-dc-inactive, #9ca3af);
		--pop-color: var(--world-map-light-pop-color, rgba(100, 116, 139, 0.4));
		--pop-highlight: var(--world-map-light-pop-highlight, rgba(14, 165, 233, 0.6));
		--arc-color: var(--world-map-light-arc-color, rgba(14, 165, 233, 0.7));
		--arc-color-inactive: var(--world-map-light-arc-color-inactive, rgba(100, 116, 139, 0.2));
		/* Arc gradient colors - light theme (blue tones) */
		--arc-start: var(--world-map-light-arc-start, rgba(14, 165, 233, 0.15));
		--arc-mid: var(--world-map-light-arc-mid, rgba(59, 130, 246, 0.4));
		--arc-end-mid: var(--world-map-light-arc-end-mid, rgba(14, 165, 233, 0.6));
		--arc-end: var(--world-map-light-arc-end, rgba(6, 182, 212, 0.9));
		--arc-inactive-start: var(--world-map-light-arc-inactive-start, rgba(100, 116, 139, 0.05));
		--arc-inactive-mid: var(--world-map-light-arc-inactive-mid, rgba(100, 116, 139, 0.12));
		--arc-inactive-end: var(--world-map-light-arc-inactive-end, rgba(100, 116, 139, 0.25));
	}

	:global([data-theme='light']) .map-legend {
		background: var(--map-legend-bg, var(--color-surface));
		color: var(--map-legend-color, var(--color-text));
	}

	/* Responsive adjustments */
	@media (max-width: 768px) {
		.map-legend {
			bottom: 8px;
			left: 8px;
			gap: 10px;
			padding: 6px 10px;
			font-size: 0.6875rem;
		}

		.grid-overlay {
			background-size: 30px 30px;
		}
	}

	@media (max-width: 480px) {
		.map-legend {
			flex-wrap: wrap;
			justify-content: flex-start;
			gap: 8px;
			max-width: 200px;
		}
	}
</style>
