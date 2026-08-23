import os
import zipfile

def zip_project(output_filename, source_dir):
    ignored_dirs = {'node_modules', '.git', 'postgres_data', 'redis_data', 'dist', '.tsbuildinfo', '.gemini', 'null'}
    ignored_files = {output_filename, '.env'}

    print(f"Zipping project directories in: {source_dir} -> {output_filename}")
    count = 0
    with zipfile.ZipFile(output_filename, 'w', zipfile.ZIP_DEFLATED) as zipf:
        for root, dirs, files in os.walk(source_dir):
            # Prune ignored directories in-place so os.walk doesn't visit them
            dirs[:] = [d for d in dirs if d not in ignored_dirs and not d.startswith('.')]
            
            for file in files:
                if file in ignored_files or file.endswith('.zip') or file.endswith('.log'):
                    continue
                
                full_path = os.path.join(root, file)
                # Create a relative path for the zip file archive structure
                relative_path = os.path.relpath(full_path, source_dir)
                zipf.write(full_path, relative_path)
                count += 1
                
    print(f"Success! Compressed {count} files into {output_filename}")

if __name__ == "__main__":
    output_zip = "seat-booking-system.zip"
    project_root = os.path.dirname(os.path.abspath(__file__))
    zip_project(output_zip, project_root)
