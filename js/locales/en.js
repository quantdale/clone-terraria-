/* locales/en.js — canonical English fallback catalog (W20, LOC-001).
//
// Registered into TC.Localization at script-load time. This file owns ALL
// normal user-facing English text: menus, HUD, inventory/crafting/shop/
// chest panels, tooltips, NPC dialogue, progression announcements, player
// feedback and every displayable content name/description.
//
// Key conventions (see docs/ARCHITECTURE.md §W20):
//   ui.*                       static interface strings
//   progress.*                 milestone announcement templates
//   event.*                    world event banners
//   feedback.*                 player-facing action feedback
//   tile|wall|item|enemy|npc|buff|biome|station
//       .<ns>.<name>.name/.description/.dialogue.*
//                              registry-stable content keys derived from
//                              'namespace:name' ids — never from def.name
//   prefix.*                   accessory reforge prefixes
//   app.title                  document title
//
// Machine identity (registry ids, save keys, flags, command/event names,
// enemy types...) deliberately does NOT live here and must never be derived
// from translated values. Legacy def.name strings stay frozen as identity
// metadata; this catalog is authoritative for presentation.
//
// All wording below is the project's original text (no external game data).
// Interpolation placeholders are '{name}'; plural entries use
// {zero?,one,two?,few?,many?,other} forms selected by Intl.PluralRules. */
'use strict';
(function () {
  const TC = window.TC;
  if (!TC || !TC.Localization || TC.Localization.isRegistered('en')) return;

  TC.Localization.register('en', {
    'app.title': 'Terraria Clone',

    // ---- title screen & lifecycle --------------------------------------
    ui: {
      menu: {
        new_world: 'New World',
        custom_seed: 'Custom Seed',
        continue_world: 'Continue World',
        seed_prompt: 'Enter a world seed (integer):',
        seed_invalid: 'Invalid seed - enter an integer',
        new_world_confirm: 'Generate a new world? Unsaved changes since the last save will be lost.',
        host_multiplayer: 'Host Local Multiplayer',
        join_server: 'Join Local Server',
      },
      net: {
        unavailable: 'Multiplayer modules unavailable',
        host_failed: 'Could not start session: {error}',
        host_started: 'Hosting - other players can Join Local Server now',
        join_prompt: 'Server URL:',
        connecting: 'Connecting to server...',
        connected: 'Joined the session',
        rejected: 'Connection rejected by server',
        link_lost: 'Multiplayer connection lost',
        server_closed: 'The multiplayer session ended',
        disconnected: 'Left the session',
        host_name: 'Host',
        guest_name: 'Guest',
      },
      pause: {
        title: 'PAUSED',
        resume: 'Resume',
        save: 'Save',
        save_quit: 'Save & Quit to Title',
        sound: 'Sound: {state}',
        new_world: 'New World',
      },
      common: {
        on: 'On',
        off: 'Off',
      },
      toast: {
        saved: 'Saved',
        save_failed: 'Save failed',
        sound_on: 'Sound on',
        sound_off: 'Sound off',
        sorted: { one: 'Sorted {n} stack', other: 'Sorted {n} stacks' },
        nothing_to_sort: 'Nothing to sort',
        stored: { one: 'Stored {n} item', other: 'Stored {n} items' },
        nothing_to_store: 'Nothing to store',
        no_chest_nearby: 'No chest nearby',
        select_hotbar_stack: 'Select a hotbar slot holding a stack',
        pinned: 'Pinned (kept by Quick Stack)',
        unpinned: 'Unpinned',
        inventory_full: 'Inventory full',
      },
      inventory: {
        title: 'INVENTORY',
        unavailable: '(inventory unavailable)',
        btn_sort: 'Sort',
        btn_stack: 'Quick Stack',
        btn_split: 'Split',
      },
      chest: {
        title: 'CHEST',
        unavailable: '(unavailable)',
      },
      equip: {
        title: 'EQUIP',
        head: 'Head',
        body: 'Body',
        feet: 'Feet',
      },
      crafting: {
        title: 'CRAFTING',
        toggle_craftable: 'Craftable',
        toggle_all: 'All',
        unavailable: '(unavailable)',
        nearby_stations: 'Nearby: {stations}',
        no_station: 'no station nearby',
        more: '+{n} more...',
      },
      shop: {
        title: 'SHOP - click a line to buy',
        price_each: { one: 'Price: {n} coin each', other: 'Price: {n} coins each' },
        bought: 'Bought {item}',
        sold_for: 'Sold for {amount}',
        purchase_failed: 'Purchase failed',
        not_buyable: 'They will not buy that',
        cannot_sell: 'Cannot sell that',
        tooltip_affordable: 'price: {price} - RMB a bag slot to sell',
        tooltip_poor: 'price: {price} - you have {purse} - RMB a bag slot to sell',
      },
      death: {
        title: 'You were slain...',
        respawn_in: 'Respawning in {n}...',
        respawn_now: 'Respawning...',
      },
      minimap: {
        hint: '[N] map',
      },
      tooltip: {
        damage: 'damage {value}',
        tool_power: '{tool} power {value}%',
        defense: '+{value} defense',
        use_time: 'use time {value}s',
        placeable: 'placeable',
        material: 'crafting material',
        ammunition: 'ammunition',
        armor_slot: 'armor - worn on {slot}',
        summons: 'summons {boss} at night',
        max_stack: 'max stack {n}',
        pin_hint: 'Ctrl+click: pin (kept by Quick Stack)',
        unpin_hint: 'Ctrl+click: unpin',
      },
      tool: {
        pick: 'pick',
        axe: 'axe',
        hammer: 'hammer',
        any: 'tool',
        generic: 'tool',
      },
      title_screen: {
        subtitle: 'an original-assets fan tribute',
        controls_1: 'WASD move · Space jump · LMB mine / place / attack',
        controls_2: 'E inventory · Esc menu · M mute · F3 debug',
      },
      craft: {
        requires: 'requires: {stations}',
        missing_station: 'missing station: {stations}',
        cost: '{item}: {have}/{need}',
        cost_tag: '{tag}: x{n}',
      },
    },

    // ---- progression announcements & events ----------------------------
    progress: {
      boss_defeated: 'Victory! The {boss} has fallen.',
      boss_awakened: '{boss} has awoken!',
      biome_discovered: 'Discovered: {biome}.',
      npc_moved_in: '{npc} has moved in!',
    },
    event: {
      blood_moon_rising: 'The Blood Moon is rising...',
      blood_moon_set: 'The Blood Moon has set.',
    },

    // ---- player-facing action feedback ---------------------------------
    feedback: {
      summon: {
        night: 'The {charm} only stirs at night...',
        day: 'The {charm} only stirs by day...',
        biome: 'The {charm} only stirs in the {biome}...',
        underworld: 'The {charm} only stirs in the Underworld...',
        progression: 'The {charm} lies silent... its moment has not come.',
        wall: 'The {charm} cannot find a stable wall...',
        boss_active: 'A boss already stalks this world...',
        blood_moon_active: 'The Blood Moon already rises...',
      },
      magic: {
        no_mana: 'Not enough mana!',
        potion_sickness: 'Potion sickness!',
        mana_gained: '+{n} mana',
        mana_max: 'Mana is at its limit',
        crystal_gain: '+{n} max mana',
      },
      loot: {
        hp_maxed: 'Health is maxed!',
        hp_up: '+{n} max HP',
      },
      fishing: {
        quest_new: 'New fishing quest: {fish}',
        quest_complete: 'Fishing quest complete! +{n} {reward}',
        quest_float: 'Quest!',
        caught_crate: 'Caught a {crate}!',
      },
    },

    // ---- accessory prefixes ---------------------------------------------
    prefix: {
      quick: 'Quick',
      mighty: 'Mighty',
      guarded: 'Guarded',
      lucky: 'Lucky',
      heavy: 'Heavy',
      dull: 'Dull',
    },

    // ======================================================================
    // tiles (display names; numeric ids are untouched machine values)
    // ======================================================================
    tile: {
      core: {
        air: { name: 'Air' },
        dirt: { name: 'Dirt' },
        grass: { name: 'Grass' },
        stone: { name: 'Stone' },
        wood_block: { name: 'Wood Block' },
        tree: { name: 'Tree' },
        leaves: { name: 'Leaves' },
        sand: { name: 'Sand' },
        copper_ore: { name: 'Copper Ore' },
        iron_ore: { name: 'Iron Ore' },
        gold_ore: { name: 'Gold Ore' },
        bedrock: { name: 'Bedrock' },
        torch: { name: 'Torch' },
        workbench: { name: 'Workbench' },
        furnace: { name: 'Furnace' },
        anvil: { name: 'Anvil' },
        tall_grass: { name: 'Tall Grass' },
        red_bloom: { name: 'Red Bloom' },
        yellow_bloom: { name: 'Yellow Bloom' },
        water: { name: 'Water' },
        glass: { name: 'Glass' },
        chest: { name: 'Chest' },
        door: { name: 'Door' },
        door_open: { name: 'Door (Open)' },
        snow: { name: 'Snow' },
        jungle_grass: { name: 'Jungle Grass' },
        lava: { name: 'Lava' },
        cactus: { name: 'Cactus' },
        ebonstone: { name: 'Ebonstone' },
        crimstone: { name: 'Crimstone' },
        corrupt_grass: { name: 'Corrupt Grass' },
        shadewood: { name: 'Shadewood' },
        dungeon_brick: { name: 'Dungeon Brick' },
        hell_brick: { name: 'Hell Brick' },
        sandstone_brick: { name: 'Sandstone Brick' },
        gleamstone: { name: 'Gleamstone' },
        mushroom_grass: { name: 'Mushroom Grass' },
        mushroom_stem: { name: 'Mushroom Stem' },
        granite: { name: 'Granite' },
        marble: { name: 'Marble' },
        mossy_stone: { name: 'Mossy Stone' },
        silver_ore: { name: 'Silver Ore' },
        gleam_crystal: { name: 'Gleam Crystal' },
        wood_platform: { name: 'Wood Platform' },
        rope: { name: 'Rope' },
        chain: { name: 'Chain' },
        pot: { name: 'Pot' },
        life_crystal: { name: 'Life Crystal' },
      },
      wiring: {
        wire: { name: 'Wire' },
        switch: { name: 'Switch' },
        switch_on: { name: 'Switch (On)' },
        lever: { name: 'Lever' },
        lever_on: { name: 'Lever (On)' },
        pressure_plate: { name: 'Pressure Plate' },
        timer: { name: 'Timer' },
        dart_trap: { name: 'Dart Trap' },
        inlet_pump: { name: 'Inlet Pump' },
        outlet_pump: { name: 'Outlet Pump' },
      },
    },

    // ======================================================================
    // walls
    // ======================================================================
    wall: {
      core: {
        none: { name: 'No Wall' },
        dirt_wall: { name: 'Dirt Wall' },
        stone_wall: { name: 'Stone Wall' },
        sand_wall: { name: 'Sand Wall' },
        ebonstone_wall: { name: 'Ebonstone Wall' },
        dungeon_wall: { name: 'Dungeon Wall' },
        hell_brick_wall: { name: 'Hell Brick Wall' },
        granite_wall: { name: 'Granite Wall' },
        marble_wall: { name: 'Marble Wall' },
        moss_wall: { name: 'Moss Wall' },
        gleam_wall: { name: 'Gleam Wall' },
      },
    },

    // ======================================================================
    // items — names mirror the frozen def.name identity metadata;
    // descriptions are original wording for content with real semantics.
    // ======================================================================
    item: {
      core: {
        dirt_block: { name: 'Dirt Block', description: 'Common earth. Placeable, diggable, dependable.' },
        stone_block: { name: 'Stone Block', description: 'Sturdy building block quarried from underground.' },
        wood: { name: 'Wood', description: 'Basic building material chopped from trees.' },
        sand_block: { name: 'Sand Block', description: 'Loose grains that pour like liquid.' },
        glass: { name: 'Glass', description: 'Smelted sand. Lets light through, keeps slimes out.' },
        torch: { name: 'Torch', description: 'Pushes back the dark. Requires open ground or a wall.' },
        workbench: { name: 'Workbench', description: 'Crafting station for early tools and furniture.' },
        furnace: { name: 'Furnace', description: 'Smelts ore into bars. Needs a workbench first.' },
        anvil: { name: 'Anvil', description: 'Forging station for metal gear and advanced recipes.' },
        chest: { name: 'Chest', description: 'Stores 20 stacks. Contents survive mining.' },
        wooden_door: { name: 'Wooden Door', description: 'Opens on click. Keeps night creatures outside.' },
        snow_block: { name: 'Snow Block', description: 'Packed frost from the cold biomes.' },
        jungle_grass: { name: 'Jungle Grass', description: 'Thick grass that spreads through mud.' },
        copper_ore: { name: 'Copper Ore', description: 'Soft starting ore for bars and tools.' },
        iron_ore: { name: 'Iron Ore', description: 'Reliable ore one step above copper.' },
        silver_ore: { name: 'Silver Ore', description: 'Bright ore worth smelting.' },
        gold_ore: { name: 'Gold Ore', description: 'Precious ore for the finest early gear.' },
        gleam_crystal: { name: 'Gleam Crystal', description: 'Resonant crystal found deep in old caves.' },
        gleamstone: { name: 'Gleamstone', description: 'Crystal-veined stone that glows faintly.' },
        mushroom_grass: { name: 'Mushroom Grass', description: 'Glowing fungal turf of the grottos.' },
        mushroom_stem: { name: 'Mushroom Stem', description: 'Fleshy stalk block from giant mushrooms.' },
        granite: { name: 'Granite', description: 'Smooth deep stone with a polished sheen.' },
        marble: { name: 'Marble', description: 'Pale veined stone favored by builders.' },
        mossy_stone: { name: 'Mossy Stone', description: 'Old stone softened by a coat of moss.' },
        copper_bar: { name: 'Copper Bar', description: 'Bar stock smelted from copper ore.' },
        iron_bar: { name: 'Iron Bar' },
        silver_bar: { name: 'Silver Bar' },
        gold_bar: { name: 'Gold Bar' },
        gel: { name: 'Gel', description: 'Wobbly slime residue. Burns well - torch fuel.' },
        arrow: { name: 'Arrow', description: 'Simple ammunition for bows.' },
        void_charm: { name: 'Void Charm', description: 'An unsettling talisman. Summons the Eye of the Void at night.' },
        storm_bell: { name: 'Storm Bell', description: 'Rings with thunder. Summons the Storm Jelly.' },
        beating_moss_heart: { name: 'Beating Moss Heart', description: 'Still alive, somehow. Summons the Moss Mother.' },
        storm_core: { name: 'Storm Core', description: 'Crackling heart of the Storm Jelly.' },
        verdant_core: { name: 'Verdant Core', description: 'Humming seed-heart of the Moss Mother.' },
        copper_coin: { name: 'Copper Coin', description: 'Smallest denomination. Worth 1.' },
        silver_coin: { name: 'Silver Coin', description: 'Worth 100 copper.' },
        gold_coin: { name: 'Gold Coin', description: 'Worth 10000 copper. Guard it well.' },
        empty_bucket: { name: 'Empty Bucket', description: 'Scoops up liquids; right-click a settled pool.' },
        water_bucket: { name: 'Water Bucket', description: 'Carries water. Pour with a click.' },
        lava_bucket: { name: 'Lava Bucket', description: 'Carries lava. Mind your boots.' },
        honey_bucket: { name: 'Honey Bucket', description: 'Carries slow, sticky honey.' },
        grappling_hook: { name: 'Grappling Hook', description: 'Fire at solid rock to yank yourself across gaps.' },
        gemshot_hook: { name: 'Gemshot Hook', description: 'Crystal-tipped hook with greater reach and pull.' },
        copper_helmet: { name: 'Copper Helmet' },
        copper_mail: { name: 'Copper Mail' },
        copper_greaves: { name: 'Copper Greaves' },
        iron_helmet: { name: 'Iron Helmet' },
        silver_helmet: { name: 'Silver Helmet' },
        silver_mail: { name: 'Silver Mail' },
        silver_greaves: { name: 'Silver Greaves' },
        crystal_blade: { name: 'Crystal Blade', description: 'Swift sword honed from gleam crystal.' },
        storm_blade: { name: 'Storm Blade', description: 'Charged blade forged around a storm core.' },
        verdant_cloak: { name: 'Verdant Cloak', description: 'Living-weave cloak grown around a verdant core.' },
        iron_mail: { name: 'Iron Mail' },
        iron_greaves: { name: 'Iron Greaves' },
        gold_helmet: { name: 'Gold Helmet' },
        gold_mail: { name: 'Gold Mail' },
        gold_greaves: { name: 'Gold Greaves' },
        wooden_sword: { name: 'Wooden Sword' },
        copper_sword: { name: 'Copper Sword' },
        iron_sword: { name: 'Iron Sword' },
        silver_sword: { name: 'Silver Sword' },
        gold_sword: { name: 'Gold Sword' },
        copper_pickaxe: { name: 'Copper Pickaxe' },
        iron_pickaxe: { name: 'Iron Pickaxe' },
        silver_pickaxe: { name: 'Silver Pickaxe' },
        gold_pickaxe: { name: 'Gold Pickaxe' },
        copper_axe: { name: 'Copper Axe' },
        iron_axe: { name: 'Iron Axe' },
        gold_axe: { name: 'Gold Axe' },
        wooden_bow: { name: 'Wooden Bow', description: 'Launches arrows. Hold to draw, release to fire.' },
        cactus: { name: 'Cactus' },
        ebonstone_block: { name: 'Ebonstone Block' },
        crimstone_block: { name: 'Crimstone Block' },
        shadewood_block: { name: 'Shadewood Block' },
        dungeon_brick: { name: 'Dungeon Brick' },
        hell_brick: { name: 'Hell Brick' },
        sandstone_brick: { name: 'Sandstone Brick' },
        bone: { name: 'Bone' },
        feather: { name: 'Feather' },
        blood_shard: { name: 'Blood Shard' },
        shadow_shard: { name: 'Shadow Shard' },
        granite_shard: { name: 'Granite Shard' },
        infernal_core: { name: 'Infernal Core', description: 'White-hot ember torn from the Wall itself.' },
        hellforged_blade: { name: 'Hellforged Blade', description: 'Infernal cores quenched into a searing edge.' },
        infernal_greaves: { name: 'Infernal Greaves', description: 'Boots that remember the fire they were forged in.' },
        infernal_hook: { name: 'Infernal Hook', description: 'A grapple drawn white-hot from the underworld forge.' },
        slime_crown: { name: 'Slime Crown', description: 'Wear it to court. Summons King Slime.' },
        skull_sigil: { name: 'Skull Sigil', description: 'A carved warning. Wakes what guards the dungeon.' },
        flesh_sigil: { name: 'Flesh Sigil', description: 'Beats like a drum of meat. Opens the frontier gateway.' },
        blood_sigil: { name: 'Blood Sigil', description: 'Invites the Blood Moon early.' },
        wood_platform: { name: 'Wood Platform', description: 'Jump up through, drop down with S.' },
        rope: { name: 'Rope', description: 'Climbable line. Place downward to descend safely.' },
        chain: { name: 'Chain', description: 'Hangs platforms and mechanisms.' },
        wooden_hammer: { name: 'Wooden Hammer', description: 'Shapes blocks and removes background walls.' },
        pot: { name: 'Pot' },
        life_crystal: { name: 'Life Crystal', description: 'Permanently raises maximum health by 20.' },
        heart: { name: 'Heart' },
        wooden_fishing_rod: { name: 'Wooden Fishing Rod', description: 'Cast near water, reel when the bobber dips.' },
        iron_fishing_rod: { name: 'Iron Fishing Rod', description: 'Stronger pulls land rarer fish.' },
        gold_fishing_rod: { name: 'Gold Fishing Rod', description: 'Masterwork rod with serious pulling power.' },
        worm: { name: 'Worm', description: 'Humble bait for humble fish.' },
        grub: { name: 'Grub', description: 'Juicy bait that improves your catch.' },
        minnow: { name: 'Minnow' },
        trout: { name: 'Trout' },
        perch: { name: 'Perch' },
        icefish: { name: 'Icefish' },
        seabass: { name: 'Seabass' },
        catfish: { name: 'Catfish' },
        lavafish: { name: 'Lavafish' },
        honeyfish: { name: 'Honeyfish' },
        wooden_crate: { name: 'Wooden Crate', description: 'Fished-up crate holding supplies.' },
        iron_crate: { name: 'Iron Crate', description: 'Sturdier crate with better odds.' },
        golden_crate: { name: 'Golden Crate', description: 'The catch of a lifetime.' },
      },
      acc: {
        guard_ring: { name: 'Ring of Guarding', description: 'A plain band that quietly turns blows aside.' },
        regen_band: { name: 'Band of Renewal', description: 'Slowly knits wounds closed while worn.' },
        swift_charm: { name: 'Swift Charm', description: 'Lightens the step of whoever carries it.' },
        power_glove: { name: 'Power Glove', description: 'Adds weight to every swing.' },
        aimer_lens: { name: "Aimer's Lens", description: 'Helps strikes find their mark.' },
        vital_amulet: { name: 'Amulet of Vitality', description: 'Warm pendant brimming with vigor.' },
        ironskin_potion: { name: 'Ironskin Potion', description: 'Temporarily hardens the skin against harm.' },
        regen_potion: { name: 'Regeneration Potion', description: 'Speeds natural healing for a while.' },
        swiftness_potion: { name: 'Swiftness Potion', description: 'Puts a spring in your step.' },
        wrath_potion: { name: 'Wrath Potion', description: 'Sharpens every strike at a price.' },
      },
      magic: {
        wand_sparking: { name: 'Wand of Sparking', description: 'Beginner wand. Costs a little mana per bolt.' },
        amethyst_staff: { name: 'Amethyst Staff' },
        topaz_staff: { name: 'Topaz Staff' },
        emerald_staff: { name: 'Emerald Staff' },
        sapphire_staff: { name: 'Sapphire Staff' },
        ruby_staff: { name: 'Ruby Staff' },
        diamond_staff: { name: 'Diamond Staff' },
        water_bolt: { name: 'Water Bolt', description: 'Bouncing sphere of pressurized water.' },
        flower_of_fire: { name: 'Flower of Fire', description: 'Throws burning blossoms that pierce.' },
        demon_scythe: { name: 'Demon Scythe', description: 'Summons slow, hungry blades of void.' },
        mana_potion: { name: 'Mana Potion', description: 'Restores mana. Causes potion sickness when drunk.' },
        mana_crystal: { name: 'Mana Crystal', description: 'Permanently raises maximum mana by 20.' },
      },
      gear: {
        wooden_yoyo: { name: 'Wooden Yoyo', description: 'Tethered toy that strikes on contact.' },
        metal_yoyo: { name: 'Metal Yoyo', description: 'Heavier string-and-spin, more sting.' },
        wooden_boomerang: { name: 'Wooden Boomerang', description: 'Returns to your hand after the throw.' },
        grenade: { name: 'Grenade', description: 'Short fuse, wide blast.' },
        fire_grenade: { name: 'Fire Grenade', description: 'Scatters flame where it lands.' },
        flint: { name: 'Flint', description: 'Spark-bearing stone for rough ammunition.' },
        fallen_star: { name: 'Fallen Star', description: 'Night-sky fragment with curious properties.' },
      },
      wiring: {
        wire: { name: 'Wire', description: 'Carries signals between mechanisms.' },
        switch: { name: 'Switch', description: 'Click to send a pulse through attached wire.' },
        lever: { name: 'Lever', description: 'Toggle mechanism that pulses on flip.' },
        pressure_plate: { name: 'Pressure Plate', description: 'Fires when something stands on it.' },
        timer: { name: 'Timer', description: 'Pulses on a steady rhythm while running.' },
        dart_trap: { name: 'Dart Trap', description: 'Fires a dart when pulsed. Aim away from face.' },
        actuator: { name: 'Actuator', description: 'Wired attachment that toggles a block intangible.' },
        inlet_pump: { name: 'Inlet Pump', description: 'Wired intake that draws liquid from its own cell on each pulse.' },
        outlet_pump: { name: 'Outlet Pump', description: 'Wired outflow that deposits pulsed liquid into its own cell.' },
      },
    },

    // ======================================================================
    // enemies & bosses
    // ======================================================================
    enemy: {
      core: {
        green_slime: { name: 'Green Slime' },
        blue_slime: { name: 'Blue Slime' },
        zombie: { name: 'Zombie' },
        demon_eye: { name: 'Demon Eye' },
        cave_bat: { name: 'Cave Bat' },
        eye_of_the_void: { name: 'Eye of the Void' },
        harpy: { name: 'Harpy' },
        vulture: { name: 'Vulture' },
        eater_of_souls: { name: 'Eater of Souls' },
        ice_slime: { name: 'Ice Slime' },
        sand_slime: { name: 'Sand Slime' },
        jungle_bat: { name: 'Jungle Bat' },
        skeleton: { name: 'Skeleton' },
        granite_golem: { name: 'Granite Golem' },
        blood_crawler: { name: 'Blood Crawler' },
        crimson_slime: { name: 'Crimson Slime' },
        hungry: { name: 'Hungry' },
        ember_wraith: { name: 'Ember Wraith' },
        dune_stalker: { name: 'Dune Stalker' },
        frost_wolf: { name: 'Frost Wolf' },
        snapvine: { name: 'Snapvine' },
        rock_charger: { name: 'Rock Charger' },
        void_wisp: { name: 'Void Wisp' },
        gloom_bat: { name: 'Gloom Bat' },
        storm_jellyfish: { name: 'Storm Jellyfish' },
        sporeling: { name: 'Sporeling' },
        king_slime: { name: 'King Slime' },
        skeletron: { name: 'Skeletron' },
        skeletron_hand: { name: 'Skeletron Hand' },
        wall_of_flesh: { name: 'Wall of Flesh' },
        storm_jelly: { name: 'Storm Jelly' },
        moss_mother: { name: 'Moss Mother' },
      },
    },

    // ======================================================================
    // town NPCs + dialogue pools (key arrays in npcs.js preserve cycling)
    // ======================================================================
    npc: {
      core: {
        guide: {
          name: 'Guide',
          dialogue: {
            base_01: 'Progression: craft a Workbench from wood, then a Furnace, then an Anvil from iron bars.',
            base_02: 'Torches need Gel - slimes drop it. One wood plus one gel crafts 3 torches.',
            base_03: 'Armor reduces damage you take. Forge a Copper set at the Anvil and equip it.',
            base_04: 'The Void Charm summons the Eye of the Void - use it only at night.',
            base_05: 'Chests hold 20 stacks. Right-click to open one; mine it to spill the contents.',
            base_06: 'Background walls need a pickaxe - aim at open tiles to pry them off.',
            base_07: 'Press N to toggle the minimap.',
            base_08: 'Press M to mute or unmute the sound.',
            night_01: 'Grappling hooks and buckets, friend: the hook carries you over pits, the bucket carries water and lava away.',
            night_02: 'Nights run long. Seal the door, keep a torch lit, and craft something useful while you wait.',
            night_03: "The dark bites hardest after sundown. A closed door beats a hero's luck.",
            biome_snow_01: 'Snow packs hard underfoot and the caves below freeze solid. Carry spare torches.',
            biome_snow_02: 'Ice over water holds right up until it does not. Rope and a bucket, always.',
            biome_desert_01: 'Sand pours like water when you dig it. Shore the walls or swim in dunes.',
            biome_jungle_01: 'The canopy eats torchlight here. Mark your trail with rope or torches.',
            biome_corruption_01: 'This purple rot spreads after dark. Do not build your house on cursed ground.',
            biome_underworld_01: 'It only gets hotter below this line. A full bucket outvalues any sword down there.',
            biome_cave_01: 'Listen for drips when you dig - moving water means ore nearby, or trouble ahead.',
            flag_01_01: 'You have torn the Wall itself. Infernal Cores at the anvil become a Hellforged Blade and Infernal Greaves.',
            flag_01_02: 'The Underworld no longer holds you back. Ember Wraiths now stir where the Wall once stood.',
            flag_02_01: 'A Verdant Core still hums in your bag. A workbench weaves it into a fine cloak.',
            flag_02_02: 'You have felled storm and spore both. The deep caves hold gleam for a blade to outlast them.',
            flag_03_01: 'Storm Cores ring like bells. An anvil and silver forge them into a Storm Blade.',
            flag_03_02: 'With the skies settled, the Merchant now stocks a Gemshot Hook - reach without ropes.',
            flag_04_01: 'Frost and dune both bow to a silver pick. Smelt what you mine.',
          },
        },
        merchant: {
          name: 'Merchant',
          dialogue: {
            base_01: 'Bars, torches, arrows - everything a delver needs, at honest prices.',
            base_02: 'Give me a house with a door, a light and a flat floor and I will stay.',
            base_03: 'Smelt your ore. Bars are worth more than rocks, always.',
            base_04: 'Surplus gear weighing you down? Right-click a bag slot while browsing my stock to sell it for coins.',
            night_01: 'My stall stays lit after dark - honest coin spends exactly the same by moonlight.',
            night_02: 'Lamp-lit stalls draw fewer slimes. Trust me, I have counted.',
            biome_snow_01: 'Cold thickens the oil in my scales. Warm customers get warm prices.',
            biome_desert_01: 'Sand gets into everything, even the coin purse. Rare goods turn up near dunes, though.',
            biome_jungle_01: 'Jungle fruit ferments on the vine. I move it by the barrelful, quietly.',
            biome_corruption_01: 'No stall stays open long in the rot. Buy what you need and keep moving.',
            biome_underworld_01: 'Everything burns down there except a fair bargain. Fireproof your pockets first.',
            biome_cave_01: 'Underground I sell rope, torches, and honest directions back to daylight.',
          },
        },
      },
    },

    // ======================================================================
    // buffs / statuses
    // ======================================================================
    buff: {
      core: {
        ironskin: { name: 'Ironskin' },
        regeneration: { name: 'Regeneration' },
        swiftness: { name: 'Swiftness' },
        wrath: { name: 'Wrath' },
        poisoned: { name: 'Poisoned' },
        burning: { name: 'Burning' },
        slowed: { name: 'Slowed' },
      },
    },

    // ======================================================================
    // biomes — short display names + poetic discovery/minimap titles
    // ======================================================================
    biome: {
      core: {
        forest: { name: 'Forest', title: 'The Verdant Reach' },
        desert: { name: 'Desert', title: 'the Amber Wastes' },
        snow: { name: 'Snow', title: 'the Frostbound Expanse' },
        jungle: { name: 'Jungle', title: 'the Tangled Deep' },
        ocean: { name: 'Ocean', title: 'the Endless Blue' },
        cave: { name: 'Cave', title: 'the Underdeep' },
        underworld: { name: 'Underworld', title: 'the Cinder Abyss' },
      },
    },

    // ======================================================================
    // crafting stations
    // ======================================================================
    station: {
      core: {
        workbench: { name: 'Workbench' },
        furnace: { name: 'Furnace' },
        anvil: { name: 'Anvil' },
      },
    },
  }, { name: 'English', nativeName: 'English' });

  // Apply any persisted locale preference once catalogs can satisfy it.
  if (typeof TC.Localization.restore === 'function') TC.Localization.restore();
})();
