const lockdown = require("mongoose-lockdown")
const express = require("express")
const ObjectId = require("mongoose").Types.ObjectId

const multer = require("multer")
const fs = require("fs")
const path = require("path")
const { projectDir } = require("../../constants")

const { reportProjectStatus } = require("../../mail")

const { validateParameters, constructQuery } = require("../validator/project")

const {
	badRequest,
	unauthorized,
	notFound,
	generateID
} = require("../../utils")

const _ = require("lodash")

const { model: UserModel } = require("../user")
const { rawSchema, model: ProjectModel } = require("./schema")

const router = express.Router()

// endpoints
router.get("/latest", async (req, res) => {
	const newestProjects = await ProjectModel.newestProject(8)
	return res.json(newestProjects)
})

router.get("/:id", async (req, res) => {
	const { id } = req.params
	const { _id: userId } = req.user
	const project = await ProjectModel.findOne({ _id: id })
	if (!project) return notFound(res)
	if (userId.equals(project.creator._id)) {
		const { model: ApplicationModel } = require("../application")
		// This is the creator of the project
		// populate application schema here
		const applicationsReceived = await ApplicationModel.find({
			project: id
		})
		return res.status(200).json({
			...project._doc, // otherwise it gives away lots of internal stuff when spreading
			applications: applicationsReceived
		})
	}
	return res.status(200).json(project)
})

router.delete("/:id", async (req, res) => {
	const { id } = req.params
	const { _id: userId } = req.user
	const project = await ProjectModel.findOne({ _id: id })
	if (!project) return notFound(res)
	if (!userId.equals(project.creator._id)) {
		return unauthorized(res, "Only creator of the project can delete it.")
	}
	await project.remove()

	return res.status(200).json({
		status: "deleted"
	})
})
// configure storage options
const storage = multer.diskStorage({
	destination: (req, file, cb) => {
		const dir = `${projectDir}${req.params.id}/`
		if (!fs.existsSync(projectDir)) {
			fs.mkdirSync(projectDir)
		}
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir)
		}

		cb(null, dir)
	},

	filename: (req, file, cb) => {
		cb(null, file.originalname)
	}
})

const upload = multer({
	storage,
	// allows only accepted mimetype
	fileFilter: (req, file, cb) => {
		const types = /jpeg|jpg|png|gif|pdf/
		if (!types.test(file.mimetype)) {
			return cb(new Error(`Unaccepted mimetype: ${file.mimetype}`))
		}
		cb(null, true)
	}
}).single("file")

// creating a project
router.post(
	"/",
	// small middle where to fill in a custom id for the project
	async (req, res, next) => {
		const id = await generateID(ProjectModel)
		req.params.id = id
		next()
	},
	async (req, res) => {
		if (!req.user.isPolitician) {
			return res.status(403).json({
				error: "Only politicians can create projects"
			})
		}

		// perform uploading
		upload(req, res, async err => {
			if (err) return badRequest(res, err)
			const details = _.pick(req.body, Object.keys(rawSchema))
			console.log("req.file", req.file)
			if (!_.isEmpty(req.file)) {
				details.file = req.file.filename
			} else {
				details.file = undefined
			}
			// mark the creator and id of the project
			details.creator = req.user._id
			details._id = req.params.id
			try {
				const project = new ProjectModel(details)
				await project.save()
				return res.status(201).json(details)
			} catch (err) {
				return badRequest(res, { error: err.message })
			}
		})
	}
)
// getting files for a project
// modifying a project
router.post("/:id", async (req, res) => {
	const { id } = req.params
	const project = await ProjectModel.findOne({ _id: id })
	if (!project) return notFound(res)
	if (!req.user._id.equals(project.creator._id)) return unauthorized(res)

	upload(req, res, async err => {
		if (err) return badRequest(res, err)
		const details = _.pick(
			req.body,
			Object.keys(rawSchema).filter(field => {
				// filter out those that has a lockdown in the attribute
				return !("lockdown" in rawSchema[field])
			})
		)
		Object.keys(details).forEach(field => {
			project.set(field, details[field])
		})
		// modify file name
		let fileField = undefined
		if (!_.isEmpty(req.file)) {
			fileField = `${req.file.filename}`
		}
		project.set("file", fileField)

		try {
			project.save()
			return res.status(200).json(details)
		} catch (err) {
			return badRequest(res, { error: err.message })
		}
	})
})
/*
	Get latest projects
*/
router.get("/", async (req, res) => {
	// extract query
	const recognizedParams = "title,status,nature,tags,salary,from,page".split(
		","
	)
	const query = _.pick(req.query, recognizedParams)

	if (Object.keys(query).length === 0) {
		// when no parameters are given, get the list of projects created / applied by user
		const { _id: id, isPolitician } = req.user
		if (isPolitician) {
			// give list of projects created by him.
			const createdProjects = await ProjectModel.find({ creator: id })
			return res.status(200).json(createdProjects)
		} else {
			// give list of projects applied by him.
			const { model: ApplicationModel } = require("../application")
			const appliedProjects = await ApplicationModel.find({ applicant: id })
				.populate("project")
				.select("project")
			return res.status(200).json(appliedProjects)
		}
	}
	/******** QUERY *********/
	if (!validateParameters(query)) {
		return badRequest(res, { message: "invalid query" })
	}
	const { page } = req.query
	// pagination settings
	const limit = 10
	const queryObject = constructQuery(query)

	// count total number of results
	const numProjects = await ProjectModel.find(queryObject).count()
	// get number of pages according to the limit
	const numPages = Math.floor(numProjects / limit)
	// actually get the results from query, sort and skip accordingly
	const results = await ProjectModel.find(queryObject)
		.sort("-createdAt")
		.skip((parseInt(page) - 1) * limit)
		.limit(limit)
	// then return results
	return res.status(200).json({ results, total: numPages })
})

// submit an application to a project
// id is refering to a project
router.post("/apply/:id", async (req, res) => {
	// now the application model is needed
	const { model: ApplicationModel } = require("../application")

	// only students can apply
	if (req.user.isPolitician) {
		return unauthorized(res, "politicians cannot apply for projects")
	}
	let { answers } = req.body
	if (!answers) answers = [] // answers cannot be null when inserting applications
	const { _id: userId } = req.user

	const { id: projectId } = req.params
	// check if the project exists
	const project = await ProjectModel.findOne({
		_id: projectId
	}).populate("creator")
	if (!project) return notFound(res)
	// check if the application exists...
	const application = await ApplicationModel.findOne({
		applicant: userId,
		project: projectId
	})
	// treat this as removing the application if exists
	if (application) {
		await application.remove()
		return res.status(200).json({
			message: "removed",
			...application // give back the details of the application
		})
	}
	// otherwise user is applying for such project
	// check if the applicant has answered all questions
	if (
		project.questions.length &&
		project.questions // if there are no answers, make it as an object for easier checking
			.some(question => !Object.keys(answers || {}).includes(question))
	) {
		console.log("bad request:", Object.keys(answers || []), project.questions)
		return badRequest(res, "Es fehlen Antworten auf mindestens eine Frage.")
	}
	// continue filling out the info
	const rawApplication = {
		applicant: ObjectId(userId),
		project: projectId,
		answers
	}
	const newApplication = new ApplicationModel(rawApplication)
	try {
		await newApplication.save()
		return res.status(201).json(rawApplication)
	} catch (e) {
		return badRequest(res, e)
	}
})
/**
  Common block for changing application status
*/
const setProjectStatus = async (status, req, res) => {
	const { id } = req.params
	const user = req.user
	const { error, project } = await ProjectModel.setProjectStatus({
		user,
		id,
		status
	})

	switch (error) {
		case "Missing data":
			return badRequest(res, error)
		case "Unrecognised project status":
			return badRequest(res, error)
		case "Only creator of the project can open / close it":
			return unauthorized(res, error)
		case "Project cannot be completed if it is not closed":
			return badRequest(res, error)
		default:
			const { model: ApplicationModel } = require("../application")
			const applications = await ApplicationModel.find({
				project: ObjectId(id)
			})
			await Promise.all(
				applications.map(({ applicant }) =>
					reportProjectStatus({ account: applicant, project, status })
				)
			)
			return res.status(200).json({ status, ...project })
	}
}

router.post("/open/:id", async (req, res) => {
	return await setProjectStatus("open", req, res)
})

router.post("/close/:id", async (req, res) => {
	return await setProjectStatus("closed", req, res)
})

// endpoint for marking a project as "completed"
router.post("/complete/:id", async (req, res) => {
	return await setProjectStatus("completed", req, res)
})

router.post("/bookmark/:id", async (req, res) => {
	if (req.user.isPolitician) {
		return unauthorized(res, "only students can bookmark projects")
	}
	// check if project exists
	const { id: projectId } = req.params
	const project = await ProjectModel.findOne({
		_id: projectId
	})
	if (!project) return notFound(res)
	// check if there we have the bookmark
	const { model: UserModel } = require("../user")
	const { username } = req.user
	const result = await UserModel.findOne({
		username,
		bookmarks: projectId
	})

	if (!result) {
		// the bookmark isn't there, add it.
		await UserModel.findOneAndUpdate(
			{ username },
			{
				$push: { bookmarks: ObjectId(projectId) }
			}
		)
		return res.status(201).json({
			message: "bookmark added"
		})
	} else {
		// bookmark is there, remove it.
		await UserModel.findOneAndUpdate(
			{ username },
			{
				$pull: { bookmarks: ObjectId(projectId) }
			}
		)
		return res.status(200).json({
			message: "bookmark removed"
		})
	}
})
// the rest is for serving the file of the projects
router.get("*", express.static(projectDir))
module.exports = {
	router,
	model: ProjectModel
}
