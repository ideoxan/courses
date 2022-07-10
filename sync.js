import { createClient } from "@supabase/supabase-js"
import "dotenv/config"
import glob from "glob"
import { readFile, stat } from "fs/promises"
import { lookup } from "mime-types"

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY)

main()

export default async function main() {
    // Our goal is to upload all of the files in this directory (with the exception of
    // node_modules) to the Supabase database.

    // Lets start by getting the base directory of this project.
    const baseDir = process.cwd()

    // Now we want to get all of the folders (courses) in this directory using glob.
    console.log("Looking for courses in " + baseDir)
    const courses = await asyncGlob(`${ baseDir }/!(node_modules|.git)/`)
    // Logging...
    courses.forEach(course => console.log(`\tFound course: .${ course.replace(baseDir, "") }`))
    console.log(`Found ${ courses.length } courses.`)

    // Now we want to iterate over each course and upload the files to the database.
    console.log("Uploading courses to database...")
    for (const course of courses) {
        // Get a list of all of the files in this course.
        console.log(`\tUploading files for course: .${ course.replace(baseDir, "") }`)
        const files = await asyncGlob(`${ course }/**/!(.git)`, {
            dot: true, // Include ".ixmeta.js" files
        })
        for (const file of files) {
            // For this file, lets check if it is a directory or a file.
            const stats = await stat(file)
            if (stats.isDirectory()) {
                // This is a directory, so we can skip it.
                continue
            }
            console.log(`\t\tUploading file: .${ file.replace(baseDir, "") }`)
            const fileData = await readFile(file)
            const { data, error } = await supabase.storage.from("course-content")
                .upload(file.replace(baseDir, ""), fileData, {
                    upsert: true,
                    contentType: lookup(file.split('.').pop()),
                })
            if (error) {
                console.log("\t\tFailed to upload file: " + file.replace(baseDir, ""))
                console.log(error)
            } else {
                console.log("\t\tSuccessfully uploaded file: " + file.replace(baseDir, ""))
            }
        }
        console.log(`\tFinished uploading ${ files.length } files for course: .${ course.replace(baseDir, "") }`)
    }
    console.log(`Finished uploading ${ courses.length } courses to database.`)

}

export async function asyncGlob(pattern, options = {}) {
    return new Promise((resolve, reject) => {
        glob(pattern, options, (err, files) => {
            if (err) {
                reject(err)
            } else {
                resolve(files)
            }
        })
    })
}
