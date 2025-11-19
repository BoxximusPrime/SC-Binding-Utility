// To Run: "npm run version-up <new_version>"

const fs = require('fs');
const path = require('path');

// Configuration
const FILES_TO_UPDATE = [
    {
        path: 'package.json',
        regex: /"version":\s*"(\d+\.\d+\.\d+)"/,
        replacement: '"version": "NEW_VERSION"'
    },
    {
        path: 'src-tauri/tauri.conf.json',
        regex: /"version":\s*"(\d+\.\d+\.\d+)"/,
        replacement: '"version": "NEW_VERSION"'
    },
    {
        path: 'src-tauri/Cargo.toml',
        regex: /^version\s*=\s*"(\d+\.\d+\.\d+)"/m,
        replacement: 'version = "NEW_VERSION"'
    },
    {
        path: 'src/index.html',
        regex: /<span id="app-version">v(\d+\.\d+\.\d+)<\/span>/,
        replacement: '<span id="app-version">vNEW_VERSION</span>'
    },
    {
        path: 'src/main.js',
        regex: /const CURRENT_VERSION = '(\d+\.\d+\.\d+)';/g,
        replacement: "const CURRENT_VERSION = 'NEW_VERSION';"
    }
];

// Get new version from command line
let newVersion = process.argv[2];

if (!newVersion)
{
    console.error('Error: Please provide a new version number or increment type (patch, minor, major).');
    console.log('Usage: node scripts/update-version.js <version|patch|minor|major>');
    console.log('Example: node scripts/update-version.js 0.7.2');
    console.log('Example: node scripts/update-version.js patch');
    process.exit(1);
}

const rootDir = path.resolve(__dirname, '..');
const packageJsonPath = path.join(rootDir, 'package.json');

// Read current version from package.json
let currentVersion;
try
{
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    currentVersion = packageJson.version;
} catch (err)
{
    console.error('❌ Error reading package.json:', err.message);
    process.exit(1);
}

// Handle increment keywords
if (['patch', 'minor', 'major'].includes(newVersion.toLowerCase()))
{
    const parts = currentVersion.split('.').map(Number);
    if (parts.length !== 3)
    {
        console.error(`❌ Current version '${currentVersion}' is not in x.y.z format.`);
        process.exit(1);
    }

    switch (newVersion.toLowerCase())
    {
        case 'patch':
            parts[2]++;
            break;
        case 'minor':
            parts[1]++;
            parts[2] = 0;
            break;
        case 'major':
            parts[0]++;
            parts[1] = 0;
            parts[2] = 0;
            break;
    }
    newVersion = parts.join('.');
    console.log(`Incrementing version: ${currentVersion} -> ${newVersion}`);
}

// Validate version format (simple semantic versioning)
if (!/^\d+\.\d+\.\d+$/.test(newVersion))
{
    console.error('Error: Invalid version format. Please use x.y.z (e.g., 0.7.2)');
    process.exit(1);
}

console.log(`Updating version to ${newVersion}...`);

let errors = 0;

FILES_TO_UPDATE.forEach(fileConfig =>
{
    const filePath = path.join(rootDir, fileConfig.path);

    try
    {
        if (!fs.existsSync(filePath))
        {
            console.error(`❌ File not found: ${fileConfig.path}`);
            errors++;
            return;
        }

        let content = fs.readFileSync(filePath, 'utf8');
        let updated = false;

        // Handle global regex (for multiple occurrences in same file)
        if (fileConfig.regex.global)
        {
            if (fileConfig.regex.test(content))
            {
                content = content.replace(fileConfig.regex, fileConfig.replacement.replace('NEW_VERSION', newVersion));
                updated = true;
            }
        } else
        {
            // Handle single occurrence
            const match = content.match(fileConfig.regex);
            if (match)
            {
                content = content.replace(fileConfig.regex, fileConfig.replacement.replace('NEW_VERSION', newVersion));
                updated = true;
            }
        }

        if (updated)
        {
            fs.writeFileSync(filePath, content, 'utf8');
            console.log(`✅ Updated ${fileConfig.path}`);
        } else
        {
            console.warn(`⚠️  Version pattern not found in ${fileConfig.path}`);
        }

    } catch (err)
    {
        console.error(`❌ Error updating ${fileConfig.path}:`, err.message);
        errors++;
    }
});

if (errors === 0)
{
    console.log('\n✨ Version update complete!');
} else
{
    console.log(`\n⚠️  Version update completed with ${errors} errors.`);
    process.exit(1);
}
